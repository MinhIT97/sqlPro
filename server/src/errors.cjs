'use strict';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function badRequest(code, message) {
  return new ApiError(400, code, message);
}

function unauthorized(code = 'UNAUTHORIZED', message = 'Bạn cần đăng nhập.') {
  return new ApiError(401, code, message);
}

function forbidden(code, message) {
  return new ApiError(403, code, message);
}

function notFound(message = 'Không tìm thấy.') {
  return new ApiError(404, 'NOT_FOUND', message);
}

function conflict(code, message) {
  return new ApiError(409, code, message);
}

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict
};
