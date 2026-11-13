export const BUILD_INFO = Object.freeze({
  version: process.env.APP_VERSION ?? 'development',
  gitSha: process.env.GIT_SHA ?? 'unknown',
});
