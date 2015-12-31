'use strict'; // eslint-disable-line

const dbal = require('../dbal');
const Joi = require('joi');
const levels = require('../levels.json');

module.exports = (server) => {
  server.route({
    method: 'GET',
    path: '/details',
    config: {
      cors: true,
      description: 'This allows you to read culprit details.',
      tags: ['api', 'details'],
      validate: {
        query: {
          origin: Joi.string().alphanum().min(3).required(),
          reverseDns: Joi.string().default('%'),
          standard: Joi.string().allow(''),
          timestamp: Joi.date().required(),
          level: Joi.string().allow(levels).required(),
        },
      },
    },
    handler: (request, reply) => {
      const timestamp = request.query.timestamp;
      const origin = request.query.origin;
      const level = request.query.level;
      const reverseDns = request.query.reverseDns;
      const standards = (typeof request.query.standard !== 'undefined' ? request.query.standard.split(',') : []);

      const showWithoutStandard = standards.indexOf('best-practice') !== -1;
      const OR_SHOW_WITHOUT_STANDARD_SQL = showWithoutStandard ? 'OR standard IS NULL' : '';

      request.log.debug(standards);
      request.log.debug('show without standard', showWithoutStandard);

      dbal.db().query(`
        SELECT  id,
                reverse_dns,
                original_url,
                code,
                context,
                message,
                help_url,
                selector,
                origin_library,
                standard
        FROM    ${dbal.tables.A11Y}
        WHERE   origin_project = $<origin>
        AND     crawled = $<timestamp>
        AND     level = $<level>
        AND     reverse_dns LIKE $<reverseDns>
        `
        + (standards.length ? `AND (standard = ANY($<standards>) ${OR_SHOW_WITHOUT_STANDARD_SQL})` : '') +
        `
        ORDER BY
                reverse_dns,
                origin_library,
                code;
        `, {
          origin,
          timestamp: dbal.pgp.as.date(timestamp),
          level,
          reverseDns,
          standards,
        })
        .then((data) => {
          return reply(data);
        })
        .catch((err) => {
          request.log.error(err);
          return reply(null, err);
        });
    },
  });
};
