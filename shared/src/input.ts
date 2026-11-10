import { z } from 'zod';

export const inputCommandSchema = z.strictObject({
  seq: z.number().int().min(1).max(0xffff_ffff),
  tick: z.number().int().min(0).max(0xffff_ffff),
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  thrust: z.boolean(),
  brake: z.boolean(),
  fire: z.boolean(),
});

export type InputCommand = z.infer<typeof inputCommandSchema>;

export function validateInputCommand(command: unknown): InputCommand {
  return inputCommandSchema.parse(command);
}

export function inputToKeyboard(command: Pick<InputCommand, 'turn' | 'thrust' | 'brake' | 'fire'>) {
  return {
    isDown(code: string): boolean {
      if (code === 'ArrowLeft' || code === 'KeyA') return command.turn < 0;
      if (code === 'ArrowRight' || code === 'KeyD') return command.turn > 0;
      if (code === 'ArrowUp' || code === 'KeyW') return command.thrust;
      if (code === 'Space') return command.brake;
      if (code === 'KeyF') return command.fire;
      return false;
    },
  };
}
