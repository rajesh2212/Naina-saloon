'use strict';
/** Small async route helper + typed HTTP errors. */
class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, options);
  }
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { HttpError, wrap };
