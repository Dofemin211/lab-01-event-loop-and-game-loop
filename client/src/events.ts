export interface GameEvents {
  readonly audioError: { readonly message: string };
  readonly roomJoined: { readonly room: { readonly name: string } };
  readonly scoreChanged: { readonly score: number };
  readonly fired: Readonly<Record<string, never>>;
  readonly hit: Readonly<Record<string, never>>;
  readonly exploded: Readonly<Record<string, never>>;
}

export class Bus<Events extends object> {
  readonly #handlers: {
    [Type in keyof Events]?: Set<(detail: Events[Type]) => void>;
  } = {};

  on<Type extends keyof Events>(type: Type, handler: (detail: Events[Type]) => void): () => void {
    const handlers = (this.#handlers[type] ??= new Set());
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  emit<Type extends keyof Events>(type: Type, detail: Events[Type]): void {
    this.#handlers[type]?.forEach((handler) => handler(detail));
  }
}

export function createGameEventTarget(): Bus<GameEvents> {
  return new Bus<GameEvents>();
}

export function emitGameEvent<Type extends keyof GameEvents>(
  target: Bus<GameEvents>,
  type: Type,
  detail: GameEvents[Type],
): void {
  target.emit(type, detail);
}
