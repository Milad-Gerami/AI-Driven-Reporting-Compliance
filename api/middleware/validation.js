'use strict';

function createValidationMiddleware(schemas) {
  if (!schemas || typeof schemas !== 'object') {
    throw new Error('createValidationMiddleware: schemas must be an object');
  }

  const { params, query, body } = schemas;

  if (!params && !query && !body) {
    throw new Error('createValidationMiddleware: at least one schema (params, query, body) must be provided');
  }

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema && typeof schema.safeParse !== 'function') {
      throw new Error(`createValidationMiddleware: schemas.${name} must be a Zod schema`);
    }
  }

  return function validate(req, res, next) {
    const validated = {};
    const allIssues = [];

    if (params) {
      const result = params.safeParse(req.params);
      if (result.success) {
        validated.params = result.data;
      } else {
        for (const issue of result.error.issues) {
          allIssues.push({ source: 'params', path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (query) {
      const result = query.safeParse(req.query);
      if (result.success) {
        validated.query = result.data;
      } else {
        for (const issue of result.error.issues) {
          allIssues.push({ source: 'query', path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (body) {
      const result = body.safeParse(req.body);
      if (result.success) {
        validated.body = result.data;
      } else {
        for (const issue of result.error.issues) {
          allIssues.push({ source: 'body', path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (allIssues.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: allIssues,
          request_id: req.requestId,
        },
      });
    }

    req.validated = validated;
    next();
  };
}

module.exports = createValidationMiddleware;
