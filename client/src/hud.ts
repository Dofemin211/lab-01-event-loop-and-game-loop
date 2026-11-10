import type { Bus, GameEvents } from './events.ts';

export interface HudTextTarget {
  textContent: string | null;
}

export function connectHud(eventBus: Bus<GameEvents>, element: HudTextTarget | null): () => void {
  if (!element) {
    throw new TypeError('connectHud requires a live status element.');
  }

  const unsubscribeScore = eventBus.on('scoreChanged', ({ score }) => {
    element.textContent = `Score ${score}`;
  });
  const unsubscribeRoom = eventBus.on('roomJoined', ({ room }) => {
    element.textContent = `Joined ${room.name}`;
  });
  const unsubscribeAudio = eventBus.on('audioError', ({ message }) => {
    element.textContent = message;
  });

  return () => {
    unsubscribeScore();
    unsubscribeRoom();
    unsubscribeAudio();
  };
}
