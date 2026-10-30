'use strict';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-at-least-32-characters-long';
process.env.NODE_ENV ||= 'test';
