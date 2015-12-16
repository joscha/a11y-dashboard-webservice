'use strict'; // eslint-disable-line

const Hapi = require('hapi');
const Joi = require('joi');
const hapiBunyan = require('hapi-bunyan');
const transformer = require('./src/transformer');
const fs = require('fs');
const dbal = require('./src/dbal');
const logger = require('./src/logger');
const INIT_SCRIPT = fs.readFileSync('./docker-entrypoint-initdb.d/INIT.sql', 'utf8');

dbal.db().query(INIT_SCRIPT).catch((err) => logger.error(err));

const server = new Hapi.Server();

server.connection({
  host: '0.0.0.0',
  port: 8080,
  routes: {
    timeout: {
      socket: 1000 * 60 * 5/* minutes */,
    },
  },
});

const config = {
  register: hapiBunyan,
  options: {
    logger,
  },
};

server.register(config, (err) => {
  if (err) throw err;
});

server.route({
  method: 'GET',
  path: '/healthcheck',
  handler: (request, reply) => reply('♥').type('text/plain'),
});

server.route({
  method: 'GET',
  path: '/healthcheck.db',
  handler: (request, reply) => {
    dbal.db().query('SELECT $1::int AS number', ['1'])
      .then(() => {
        return reply('♥').type('text/plain');
      })
      .catch((err) => {
        request.log.error(err);
        return reply(err).code(500);
      });
  },
});

server.route({
  method: 'GET',
  path: '/overview',
  config: {
    cors: true,
  },
  handler: (request, reply) => {
    dbal.db().query(`
      SELECT
        origin_project AS origin,
        EXTRACT(epoch FROM crawled) * 1000 AS timestamp,
        standard,
        level,
        COUNT(*) AS count
      FROM
        ${dbal.tables.A11Y}
      GROUP BY origin_project, crawled, standard, level
      ORDER BY origin_project, crawled DESC, standard, level;
      `)
      .then((data) => {
        const result = {};
        data.forEach((row) => {
          row.standard = row.standard || 'best-practice';
          const project = result[row.origin] = result[row.origin] || { datapoints: {} };
          const datapoints = project.datapoints[row.timestamp] = project.datapoints[row.timestamp] || {};
          const standard = datapoints[row.standard] = datapoints[row.standard] || {};
          standard[row.level] = row.count;
        });
        return reply(result);
      })
      .catch((err) => {
        request.log.error(err);
        return reply(null, err);
      });
  },
});

server.route({
  method: 'POST',
  path: '/load.crawlkit',
  handler: (request, reply) => {
    const results = request.payload.results;
    const timestamp = new Date(request.payload.timestamp);
    const origin = request.payload.origin;

    dbal.db().tx((t) => {
      const queries = [
        t.none(`
          DELETE FROM
            ${dbal.tables.A11Y}
          WHERE
            origin_project=$1
          AND
            crawled=$2;
          `, [origin, dbal.pgp.as.date(timestamp)]),
      ];
      return transformer.transformResult(results)
        .then((transformedResults) => {
          transformedResults.forEach((result) => {
            const insert = t.none(`
            INSERT INTO ${dbal.tables.A11Y}(
              reverse_dns,
              crawled,
              original_url,
              code,
              context,
              message,
              selector,
              level,
              origin_project,
              standard,
              origin_library
            ) VALUES (
              $<reverse_dns>,
              $<crawled>,
              $<original_url>,
              $<code>,
              $<context>,
              $<message>,
              $<selector>,
              $<level>,
              $<origin_project>,
              $<standard>,
              $<origin_library>
            );
            `,
              {
                reverse_dns: result.reverseDnsNotation,
                crawled: dbal.pgp.as.date(timestamp),
                original_url: result.url,
                code: result.code,
                context: result.context,
                message: result.msg,
                selector: result.selector,
                level: result.type,
                origin_project: origin,
                standard: result.standard ? result.standard.toLowerCase() : null,
                origin_library: result.originLibrary,
              });
            queries.push(insert);
          });
          return t.batch(queries);
        });
    })
      .then(() => reply({ error: null }).code(201))
      .catch((error) => reply(null, error).code(500));
  },
  config: {
    payload: {
      timeout: false,
      maxBytes: 1024 * 1024 * 100/* MB */,
    },
    description: 'This allows you to bulk-load results from crawlkit.',
    tags: ['api', 'bulk'],
    validate: {
      payload: Joi.object().keys({
        origin: Joi.string().alphanum().min(3).required(),
        timestamp: Joi.date().required(),
        results: Joi.object().required(),
      }).unknown(),
    },
  },
});

server.start(() => logger.info(`Server running at: ${server.info.uri}`));
