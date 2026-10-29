const PROTOCOL_VERSION = 0;

function emit(target, type, detail = {}) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

export class MultiplayerConnection extends EventTarget {
  constructor({
    url = `${globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${globalThis.location.host}/ws`,
    WebSocketClass = globalThis.WebSocket,
    random = Math.random,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
    baseDelayMs = 250,
    maxDelayMs = 8000,
    maxQueue = 50,
  } = {}) {
    super();
    this.url = url;
    this.WebSocketClass = WebSocketClass;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxQueue = maxQueue;
    this.state = 'disconnected';
    this.socket = null;
    this.room = null;
    this.joinMessage = null;
    this.queue = [];
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.wanted = false;
    this.joined = false;
  }

  connect(room, name) {
    if (typeof room !== 'string' || typeof name !== 'string' || !name.trim()) {
      throw new TypeError('A room and player name are required to connect.');
    }
    this.disconnect();
    this.room = room;
    this.joinMessage = { version: PROTOCOL_VERSION, type: 'join', room, name: name.trim() };
    this.wanted = true;
    this.#open();
  }

  sendChat(text) {
    const message = { version: PROTOCOL_VERSION, type: 'chat', text };
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 500) {
      throw new RangeError('Chat text must contain 1–500 characters.');
    }
    message.text = text.trim();
    if (this.joined && this.socket?.readyState === 1) {
      return this.#send(message);
    }
    if (!this.wanted) {
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      emit(this, 'error', { message: 'Your message queue is full. Try again after reconnecting.' });
      return false;
    }
    this.queue.push(message);
    return true;
  }

  disconnect() {
    this.wanted = false;
    this.joined = false;
    this.queue = [];
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      socket.close(1000, 'Client left the room.');
    }
    this.#setState('disconnected');
  }

  #open() {
    if (!this.wanted) {
      return;
    }
    this.#setState(this.retryCount ? 'reconnecting' : 'connecting');
    let socket;
    try {
      socket = new this.WebSocketClass(this.url);
    } catch (error) {
      emit(this, 'error', { message: `Could not connect to the game server: ${error.message}` });
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.socket || !this.wanted) {
        socket.close(1000, 'Connection is no longer needed.');
        return;
      }
      this.retryCount = 0;
      this.#setState('open');
      this.#send(this.joinMessage);
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.#handleMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (socket === this.socket) {
        emit(this, 'error', { message: 'The connection encountered a network error.' });
      }
    });
    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.socket = null;
      this.joined = false;
      if (!this.wanted) {
        this.#setState('disconnected');
        return;
      }
      emit(this, 'close', { code: event.code, reason: event.reason });
      this.#scheduleReconnect();
    });
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      emit(this, 'error', { message: 'The server sent an unreadable message.' });
      return;
    }
    if (
      !message ||
      typeof message !== 'object' ||
      message.version !== PROTOCOL_VERSION ||
      typeof message.type !== 'string'
    ) {
      emit(this, 'error', { message: 'The server sent a message with an unsupported format.' });
      return;
    }
    if (message.type === 'joined') {
      this.joined = true;
      this.#setState('joined');
      for (const queued of this.queue.splice(0)) {
        this.#send(queued);
      }
    }
    if (message.type === 'error') {
      if (!this.joined) {
        this.disconnect();
      }
      emit(this, 'error', {
        message:
          typeof message.message === 'string' ? message.message : 'The server rejected a message.',
      });
    }
    emit(this, 'message', message);
    emit(this, message.type, message);
  }

  #send(message) {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      emit(this, 'error', { message: `Could not send the message: ${error.message}` });
      return false;
    }
  }

  #scheduleReconnect() {
    if (!this.wanted || this.reconnectTimer !== null) {
      return;
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.retryCount);
    const delay = Math.round(ceiling * (0.5 + this.random() * 0.5));
    this.retryCount += 1;
    this.#setState('reconnecting');
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    emit(this, 'state', { state });
  }
}
