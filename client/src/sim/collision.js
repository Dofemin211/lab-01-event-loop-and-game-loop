export function circlesOverlap(a, b) {
  if (!a.alive || !b.alive || !a.collidable || !b.collidable) {
    return false;
  }
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const combinedRadius = a.radius + b.radius;
  return dx * dx + dy * dy <= combinedRadius * combinedRadius;
}

export function* collisionPairs(world) {
  const entities = [...world];
  for (let first = 0; first < entities.length; first += 1) {
    const a = entities[first];
    if (!a.alive || !a.collidable) {
      continue;
    }
    for (let second = first + 1; second < entities.length; second += 1) {
      const b = entities[second];
      if (circlesOverlap(a, b)) {
        yield [a, b];
      }
    }
  }
}

function addExplosion(world, entity) {
  const explosion = world.spawn(world.createExplosion(entity.pos.x, entity.pos.y));
  world.emit('exploded', { entity, explosion });
}

function damageShip(world, ship, damage, events) {
  const destroyed = ship.takeDamage(damage);
  world.emit('hit', { entity: ship, damage, destroyed });
  if (destroyed) {
    events.push({ type: 'ship-destroyed', entity: ship });
    addExplosion(world, ship);
  } else if (!ship.alive) {
    events.push({ type: 'ship-destroyed', entity: ship });
    addExplosion(world, ship);
  } else {
    events.push({ type: 'ship-hit', entity: ship });
  }
}

function handleBulletCollision(world, bullet, target, events) {
  if (bullet.ownerId === target.id || !target.alive) {
    return;
  }
  bullet.alive = false;

  if (target.kind === 'asteroid') {
    const destroyed = target.takeDamage(bullet.damage);
    world.emit('hit', { entity: target, damage: bullet.damage, destroyed });
    events.push({ type: destroyed ? 'asteroid-destroyed' : 'asteroid-hit', entity: target });
    if (destroyed) {
      addExplosion(world, target);
      if (world.random() < 0.28) {
        const effect = world.random() < 0.5 ? 'shield' : 'rapid-fire';
        world.spawn(world.createPickup(target.pos.x, target.pos.y, effect));
      }
    }
  } else if (target.kind === 'ship') {
    damageShip(world, target, bullet.damage, events);
  }
}

export function resolveCollisions(world, pairs) {
  const events = [];
  for (const [a, b] of pairs) {
    if (!a.alive || !b.alive) {
      continue;
    }

    if (a.kind === 'bullet') {
      handleBulletCollision(world, a, b, events);
    } else if (b.kind === 'bullet') {
      handleBulletCollision(world, b, a, events);
    } else if (a.kind === 'ship' && b.kind === 'asteroid') {
      damageShip(world, a, 1, events);
      if (b.takeDamage() || !b.alive) {
        events.push({ type: 'asteroid-destroyed', entity: b });
        addExplosion(world, b);
      }
    } else if (b.kind === 'ship' && a.kind === 'asteroid') {
      damageShip(world, b, 1, events);
      if (a.takeDamage() || !a.alive) {
        events.push({ type: 'asteroid-destroyed', entity: a });
        addExplosion(world, a);
      }
    } else if (a.kind === 'ship' && b.kind === 'pickup') {
      b.applyTo(a);
      b.alive = false;
      events.push({ type: 'pickup-collected', entity: b, ship: a });
    } else if (b.kind === 'ship' && a.kind === 'pickup') {
      a.applyTo(b);
      a.alive = false;
      events.push({ type: 'pickup-collected', entity: a, ship: b });
    }
  }
  return events;
}
