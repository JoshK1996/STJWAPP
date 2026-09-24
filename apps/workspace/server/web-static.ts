import express, { type Express } from 'express';
import { resolve } from 'node:path';

/** Public assets only. Private API responses are never part of an offline cache. */
export function installPublicWeb(app: Express, directory = resolve('dist')) {
  app.get('/app-version.json', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('application/json');
    res.sendFile(resolve(directory, 'app-version.json'), { cacheControl: false, lastModified: false }, error => {
      if (error && !res.headersSent) res.status(503).json({ error: 'Release information is temporarily unavailable.' });
    });
  });
  app.use(express.static(directory, {
    index: false,
    maxAge: '1h',
    setHeaders(res, path) {
      // Direct /index.html requests must be as fresh as installed-app navigation.
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (path.endsWith('.webmanifest') || /[/\\]icons[/\\]/.test(path)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/{*path}', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(directory, 'index.html'), { cacheControl: false });
  });
}
