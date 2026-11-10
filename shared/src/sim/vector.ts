import type { VectorLike } from '../types.ts';

export class Vector2 {
  #x: number;
  #y: number;

  constructor(x = 0, y = 0) {
    this.#x = x;
    this.#y = y;
  }

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }

  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  add(other: VectorLike): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other: VectorLike): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(amount: number): Vector2 {
    return new Vector2(this.x * amount, this.y * amount);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  lengthSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): Vector2 {
    const magnitude = this.length();
    return magnitude === 0 ? new Vector2() : this.scale(1 / magnitude);
  }

  rotate(angle: number): Vector2 {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Vector2(this.x * cosine - this.y * sine, this.x * sine + this.y * cosine);
  }

  dot(other: VectorLike): number {
    return this.x * other.x + this.y * other.y;
  }

  addInPlace(other: VectorLike): this {
    this.#x += other.x;
    this.#y += other.y;
    return this;
  }

  subInPlace(other: VectorLike): this {
    this.#x -= other.x;
    this.#y -= other.y;
    return this;
  }

  scaleInPlace(amount: number): this {
    this.#x *= amount;
    this.#y *= amount;
    return this;
  }

  static fromAngle(angle: number, magnitude = 1): Vector2 {
    return new Vector2(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
  }
}
