import { parseRooms } from '../lobby.ts';
import type { Lobby, LobbyRoom, RoomSelection } from '../lobby.ts';

interface LobbyElements {
  readonly root: HTMLElement;
  readonly rooms: HTMLElement;
  readonly playerName: HTMLInputElement;
  readonly joinButton: HTMLButtonElement;
  readonly refreshButton: HTMLButtonElement;
  readonly status: HTMLElement;
}

interface LobbyRoomsDetail {
  readonly rooms: readonly LobbyRoom[];
}

interface LobbyErrorDetail {
  readonly error: unknown;
}

interface LobbyStateDetail {
  readonly state: string;
}

function customDetail(event: Event): unknown {
  if (!(event instanceof CustomEvent)) {
    throw new TypeError('Lobby notifications must be CustomEvent instances.');
  }
  return event.detail;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function connectLobbyUI(
  lobby: Lobby,
  elements: LobbyElements,
  { onJoin }: { readonly onJoin: (selection: RoomSelection) => void },
): {
  show(): void;
  hide(): void;
  dispose(): void;
} {
  const { root, rooms, playerName, joinButton, refreshButton, status } = elements;
  let selectedRoomId: string | null = null;
  let roomListSignature = '';

  function renderRooms(event: Event): void {
    const detail = customDetail(event);
    if (!record(detail) || !Array.isArray(detail.rooms)) {
      throw new TypeError('Room list notification must contain a rooms array.');
    }
    const availableRooms = parseRooms({ rooms: detail.rooms });
    const signature = JSON.stringify(availableRooms);
    if (signature === roomListSignature) {
      status.textContent = `${availableRooms.length} rooms available. Select a room to join.`;
      joinButton.disabled = selectedRoomId === null;
      return;
    }
    roomListSignature = signature;
    const previousSelection = selectedRoomId;
    selectedRoomId = availableRooms.some(
      (room) => room.id === previousSelection && room.players < room.maxPlayers,
    )
      ? previousSelection
      : null;
    rooms.replaceChildren();
    for (const room of availableRooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-card';
      button.dataset.roomId = room.id;
      button.setAttribute('aria-pressed', String(room.id === selectedRoomId));
      const name = document.createElement('strong');
      name.textContent = room.name;
      const description = document.createElement('span');
      description.textContent = `${room.players}/${room.maxPlayers} pilots · ${room.arena.asteroidCount} asteroids`;
      button.append(name, description);
      button.disabled = room.players >= room.maxPlayers;
      button.addEventListener('click', () => {
        selectedRoomId = room.id;
        for (const card of rooms.querySelectorAll('.room-card')) {
          card.setAttribute('aria-pressed', String(card === button));
        }
        joinButton.disabled = false;
      });
      rooms.append(button);
    }
    status.textContent = `${availableRooms.length} rooms available. Select a room to join.`;
    joinButton.disabled = selectedRoomId === null;
  }

  function onError(event: Event): void {
    const detail = customDetail(event);
    if (!record(detail) || !('error' in detail)) {
      throw new TypeError('Lobby error notification must contain an error.');
    }
    status.textContent = `Could not refresh rooms: ${errorText(detail.error)}`;
    joinButton.disabled = true;
  }

  function onState(event: Event): void {
    const detail = customDetail(event);
    if (!record(detail) || typeof detail.state !== 'string') {
      throw new TypeError('Lobby state notification must contain a state.');
    }
    const state = detail.state;
    if (state === 'loading') {
      status.textContent = 'Refreshing rooms…';
    }
  }

  function updateName(): void {
    try {
      lobby.setPlayerName(playerName.value);
      playerName.setCustomValidity('');
    } catch (error: unknown) {
      playerName.setCustomValidity(errorText(error));
    }
  }

  function handleJoin(): void {
    updateName();
    if (!playerName.reportValidity() || !selectedRoomId) {
      return;
    }
    try {
      onJoin(lobby.join(selectedRoomId));
    } catch (error: unknown) {
      status.textContent = errorText(error);
    }
  }

  function refresh(): void {
    void lobby.refresh().catch(() => undefined);
  }

  lobby.addEventListener('roomsChanged', renderRooms);
  lobby.addEventListener('lobbyError', onError);
  lobby.addEventListener('stateChanged', onState);
  playerName.addEventListener('input', updateName);
  joinButton.addEventListener('click', handleJoin);
  refreshButton.addEventListener('click', refresh);

  return {
    show(): void {
      root.hidden = false;
      lobby.start();
    },
    hide(): void {
      root.hidden = true;
      lobby.stop();
    },
    dispose(): void {
      lobby.stop();
      lobby.removeEventListener('roomsChanged', renderRooms);
      lobby.removeEventListener('lobbyError', onError);
      lobby.removeEventListener('stateChanged', onState);
      playerName.removeEventListener('input', updateName);
      joinButton.removeEventListener('click', handleJoin);
      refreshButton.removeEventListener('click', refresh);
    },
  };
}
