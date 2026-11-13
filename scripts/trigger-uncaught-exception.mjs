const onNewListener = (event) => {
  if (event === 'uncaughtException') {
    process.off('newListener', onNewListener);
    queueMicrotask(() => {
      throw new Error('Production crash-handler smoke test.');
    });
  }
};

process.on('newListener', onNewListener);
