(function(){
    'use strict';

    angular.module('soundCloudify')
        .service("SyncService", SyncService);

    var ORIGIN_LOCAL = 'l';
    var ORIGIN_SERVER = 's';
    var PLAYLIST_STORAGE_KEY = 'playlist';
    var NOW_PLAYING_LIST_KEY = 'nowPlaying';

    function SyncService($rootScope, $q, $http, $timeout, API_ENDPOINT, StorageService){

        var user;
        var lastSynced = localStorage.getItem('lastSynced');

        var PlaylistStorage = StorageService.getStorageInstance('playlist');
        var StarredStorage = StorageService.getStorageInstance('starred');

        var pulling = false;
        var pushing = false;


        return {
            init: init,
            sync: sync,
            pull: pull,
            push: push,
            bumpLastSynced: bumpLastSynced
        };

        function init() {
            $rootScope.$on('identity.confirm', function(event, data) {
                if (data.identity.id) {
                    user = data.identity;
                    console.log('let sync!');

                    //start sync after 1s
                    $timeout(function() {
                        sync();
                    }, 1000);
                }
            });
        };

        function sync() {

            $rootScope.$broadcast('sync.start');

            pull().then(push).then(bumpLastSynced);
        }

        function pull() {

            if (pulling) {
                console.log('SyncService::pull() is in progress');
                reject();
                return;
            }

            if (!user) {
                console.log('SyncService::pull() no user');
                reject();
                return;
            }

            console.log('SyncService::pull()');

            pulling = true;

            return $q(function(resolve, reject) {

                var dataURL = API_ENDPOINT + '/data';

                if (lastSynced) {
                    dataURL += '?from=' + lastSynced;
                }

                //fetch the changes
                $http.get(dataURL).success(function(serverData) {

                    _.each(serverData.playlists, function(playlist, index) {

                        if (playlist.deleted) {

                            PlaylistStorage.delete(playlist.uuid);

                        } else {

                            if (!playlist.uuid) {
                                playlist.uuid = window.ServiceHelpers.ID();
                            }

                            playlist.sync = 1;

                            PlaylistStorage.upsert(playlist);
                        }

                    });

                    if (serverData.starred.tracks) {
                        _.each(serverData.starred.tracks, function(track) {
                            track.sync = 1;
                        });

                        StarredStorage.upsert(serverData.starred.tracks);
                    }

                    resolve(serverData.time);

                    pulling = true;
                });

            });

        }

        function push(lastSynced) {

            return $q(function(resolve, reject) {

                if (pushing) {
                    console.log('SyncService::push() is in progress');
                    reject();
                    return;
                }

                if (!user) {
                    console.log('SyncService::push() no user');
                    reject();
                    return;
                }

                console.log('SyncService::push()');

                pushing = true;

                $q.all({
                        unsyncedPlaylists: PlaylistStorage.getUnsyncedPlaylists(),
                        unsyncedStarredTracks: StarredStorage.getUnsyncedTracks()
                    })
                    .then(function(result) {

                        /**
                         * Detecting changes
                         */
                        var localPlaylists = result.unsyncedPlaylists;
                        var localStarredTracks = result.unsyncedStarredTracks;

                        var promises = [];

                        //=========================================
                        //Playlist
                        //=========================================
                        _.each(localPlaylists, function(playlist) {

                            //brand new playlist
                            if (!playlist.id) {
                                promises.push(
                                    $http({
                                        url: API_ENDPOINT + '/playlist',
                                        method: 'POST',
                                        data: playlist,
                                    })
                                );
                            } else if(!playlist.deleted) { //playlist already stored, but tracks has been added or removed

                                var tracksToAdd = _.filter(playlist.tracks, function(track) {
                                    return !track.internalId && !track.deleted;
                                });

                                var tracksToRemove = _.filter(playlist.tracks, function(track) {
                                    return track.internalId && track.deleted;
                                });

                                promises.push(
                                    $http({
                                        url: API_ENDPOINT + '/playlist/' + playlist.id,
                                        method: 'PUT',
                                        data: {
                                            added: tracksToAdd,
                                            removed: _.map(tracksToRemove, function(removal) { return removal.internalId; })
                                        }
                                    })
                                );
                            } else if(playlist.id && playlist.deleted){
                                promises.push(
                                    $http({
                                        url: API_ENDPOINT + '/playlist/' + playlist.id,
                                        method: 'DELETE'
                                    })
                                );
                            }

                        });

                        //=========================================
                        //Starred
                        //=========================================
                        var starred = _.filter(localStarredTracks, function(track) {
                            return !track.internalId;
                        });
                        starred = _.sortBy(starred, function(track) {return track.order});

                        var unstarred = _.filter(localStarredTracks, function(track) {
                            return track.internalId && track.deleted === 1;
                        });

                        if (starred.length || unstarred.length) {
                            promises.push(
                                $http({
                                    url: API_ENDPOINT + '/star',
                                    method: 'PUT',
                                    data: {
                                        added : starred,
                                        removed: _.map(unstarred, function(removal) { return removal.internalId; })
                                    }
                                })
                            );
                        } else {
                            promises.push($q(function(resolve, reject){ resolve('star'); }));
                        }

                        $q.all(promises).then(function(responses) {

                            var starredResponse = responses.splice(responses.length - 1, 1)[0];
                            var playlistResponse = responses;

                            //update unsynced tracks
                            _.each(playlistResponse, function(response, index) {

                                var playlist = localPlaylists[index];

                                if (playlist && response.data.id) {
                                    playlist.id = response.data.id;
                                    playlist.updated = response.data.updated;
                                    playlist.sync = 1;
                                    PlaylistStorage.upsert(playlist);
                                    lastSynced = response.data.time;
                                } else if (playlist && response.data.length){

                                    //update the song that has been stored
                                    _.each(response.data[0], function(serverTrack, index) {
                                        var trackInPlaylist = _.findWhere(playlist.tracks, {uuid: serverTrack.uuid});
                                        if (trackInPlaylist) {
                                            trackInPlaylist.internalId = serverTrack.internalId;
                                        }
                                    });

                                    //remove the song that marked as deleted
                                    //TODO: check if the song is really removed???
                                    playlist.tracks = _.filter(playlist.tracks, function(track) {
                                        return !track.deleted;
                                    });

                                    playlist.sync = 1;
                                    PlaylistStorage.upsert(playlist);
                                    lastSynced = response.data[2].time;
                                } else if (playlist.deleted) {
                                    PlaylistStorage.delete(playlist.uuid);
                                    lastSynced = response.data.time;
                                }

                            });

                            //update star list
                            //TODO: remove the deleted one
                            if (starredResponse && starredResponse.data && starredResponse.data.length) {
                                //data[0]: result of added
                                //data[1]: result of removed
                                //data[2]: for time

                                _.each(starredResponse.data[0], function(internalId, index) {
                                    var track = starred[index];
                                    track.internalId = internalId.internalId;
                                    track.sync = 1;
                                });

                                StarredStorage.upsert(starred);

                                var unstarredIds = _.map(unstarred, function(removal) { return removal.uuid; });

                                StarredStorage.delete(unstarredIds);

                                lastSynced = starredResponse.data[2].time;
                            }

                            pushing = false;

                            resolve(lastSynced);

                        }, function() {
                            pushing = false;
                            reject();
                        });
                    });
            });

        }

        function bumpLastSynced(lastSynced) {

            if (!lastSynced) return;

            localStorage.setItem('lastSynced', lastSynced);
            $rootScope.$broadcast('sync.completed');
        }
    };

}());
