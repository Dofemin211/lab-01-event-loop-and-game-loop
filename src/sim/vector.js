export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other) {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(amount) {
    return new Vector2(this.x * amount, this.y * amount);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  lengthSquared() {
    return this.x * this.x + this.y * this.y;
  }

  normalize() {
    const magnitude = this.length();
    return magnitude === 0 ? new Vector2() : this.scale(1 / magnitude);
  }

  rotate(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Vector2(this.x * cosine - this.y * sine, this.x * sine + this.y * cosine);
  }

  dot(other) {
    return this.x * other.x + this.y * other.y;
  }

  addInPlace(other) {
    this.x += other.x;
    this.y += other.y;
    return this;
  }

  subInPlace(other) {
    this.x -= other.x;
    this.y -= other.y;
    return this;
  }

  scaleInPlace(amount) {
    this.x *= amount;
    this.y *= amount;
    return this;
  }

  static fromAngle(angle, magnitude = 1) {
    return new Vector2(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
  }
}
