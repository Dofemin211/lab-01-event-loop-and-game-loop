const onNewListener = (event) => {
  if (event === 'unhandledRejection') {
    process.off('newListener', onNewListener);
    queueMicrotask(() => {
      Promise.reject(new Error('Production unhandled-rejection smoke test.'));
    });
  }
};

process.on('newListener', onNewListener);
