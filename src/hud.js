export function connectHud(eventTarget, element) {
  if (!element) {
    throw new TypeError('connectHud requires a live status element.');
  }

  const updateScore = (event) => {
    element.textContent = `Score ${event.detail.score}`;
  };
  const announceRoom = (event) => {
    element.textContent = `Joined ${event.detail.room.name}`;
  };
  const reportAudio = (event) => {
    element.textContent = event.detail.message;
  };

  eventTarget.addEventListener('scoreChanged', updateScore);
  eventTarget.addEventListener('roomJoined', announceRoom);
  eventTarget.addEventListener('audioError', reportAudio);

  return () => {
    eventTarget.removeEventListener('scoreChanged', updateScore);
    eventTarget.removeEventListener('roomJoined', announceRoom);
    eventTarget.removeEventListener('audioError', reportAudio);
  };
}
