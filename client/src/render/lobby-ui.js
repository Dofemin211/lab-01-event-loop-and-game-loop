export function connectLobbyUI(lobby, elements, { onJoin }) {
  const { root, rooms, playerName, joinButton, refreshButton, status } = elements;
  let selectedRoomId = null;
  let roomListSignature = '';

  function renderRooms(event) {
    const signature = JSON.stringify(event.detail.rooms);
    if (signature === roomListSignature) {
      status.textContent = `${event.detail.rooms.length} rooms available. Select a room to join.`;
      joinButton.disabled = selectedRoomId === null;
      return;
    }
    roomListSignature = signature;
    const previousSelection = selectedRoomId;
    selectedRoomId = event.detail.rooms.some(
      (room) => room.id === previousSelection && room.players < room.maxPlayers,
    )
      ? previousSelection
      : null;
    rooms.replaceChildren();
    for (const room of event.detail.rooms) {
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
    status.textContent = `${event.detail.rooms.length} rooms available. Select a room to join.`;
    joinButton.disabled = selectedRoomId === null;
  }

  function onError(event) {
    status.textContent = `Could not refresh rooms: ${event.detail.error.message}`;
    joinButton.disabled = true;
  }

  function onState(event) {
    if (event.detail.state === 'loading') {
      status.textContent = 'Refreshing rooms…';
    }
  }

  function updateName() {
    try {
      lobby.setPlayerName(playerName.value);
      playerName.setCustomValidity('');
    } catch (error) {
      playerName.setCustomValidity(error.message);
    }
  }

  function handleJoin() {
    updateName();
    if (!playerName.reportValidity() || !selectedRoomId) {
      return;
    }
    try {
      onJoin(lobby.join(selectedRoomId));
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function refresh() {
    lobby.refresh().catch(() => {});
  }

  lobby.addEventListener('roomsChanged', renderRooms);
  lobby.addEventListener('lobbyError', onError);
  lobby.addEventListener('stateChanged', onState);
  playerName.addEventListener('input', updateName);
  joinButton.addEventListener('click', handleJoin);
  refreshButton.addEventListener('click', refresh);

  return {
    show() {
      root.hidden = false;
      lobby.start();
    },
    hide() {
      root.hidden = true;
      lobby.stop();
    },
    dispose() {
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
