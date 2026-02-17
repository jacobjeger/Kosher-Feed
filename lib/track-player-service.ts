import TrackPlayer, { Event } from "react-native-track-player";

module.exports = async function () {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => TrackPlayer.seekTo(event.position));
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (event) => {
    const pos = await TrackPlayer.getPosition();
    await TrackPlayer.seekTo(pos + event.interval);
  });
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (event) => {
    const pos = await TrackPlayer.getPosition();
    await TrackPlayer.seekTo(Math.max(0, pos - event.interval));
  });
};
