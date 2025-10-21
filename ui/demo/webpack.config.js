const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const axios = require('axios');

module.exports = {
  entry: ['./index.tsx', './less/main.less'],
  module: {
    rules: [
      {
        test: /\.(less|css)$/,
        use: [
          { loader: 'style-loader' },
          { loader: 'css-loader' },
          { loader: 'less-loader', options: { lessOptions: { javascriptEnabled: true } } },
        ],
      },
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  devtool: 'eval-source-map',
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
  },
  plugins: [
    new CleanWebpackPlugin(),
    // This copies `public/index.html` into the build output directory.
    new HtmlWebpackPlugin({
      template: 'public/index.html',
      /* This ensures that links to injected scripts, styles and images start at the
       * root instead of being relative to the current URL. Without this deep
       * URLs that target the URI don't work.
       */
      publicPath: '/',
    }),
    // This copies everything that isn't `index.html` from `public/` into the build output
    // directory.
    new CopyPlugin({
      patterns: [
        {
          from: 'public/**/*',
          filter: absPathToFile => {
            return absPathToFile !== path.resolve(__dirname, 'public', 'index.html');
          },
          transformPath: p => p.replace(/^public\//, ''),
        },
        {
          from: 'node_modules/pdfjs-dist/cmaps/',
          to: 'cmaps/',
        },
      ],
    }),
  ],
  output: {
    filename: 'main.[fullhash:6].js',
    path: path.resolve(__dirname, 'build'),
  },
  devServer: {
    hot: true,
    host: '0.0.0.0',
    // The `ui` host is used by the reverse proxy when requesting the UI while working locally.
    allowedHosts: ['ui'],
    historyApiFallback: true,
    port: 3000,
    // Apparently webpack's dev server doesn't write files to disk. This makes it hard to
    // debug the build process, as there's no way to examine the output. We change this
    // setting so that it's easier to inspect what's built. This in theory might make things
    // slower, but it's probably worth the extra nanosecond.
    writeToDisk: true,
    lazy: false,
    before: app => {
      app.use('/proxy-pdf', async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'Range');
          res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
          res.status(204).end();
          return;
        }

        if (!['GET', 'HEAD'].includes(req.method || '')) {
          res.status(405).send('Method not allowed');
          return;
        }

        const target = req.query?.url;

        if (typeof target !== 'string' || target.length === 0) {
          res.status(400).send('Missing url query parameter');
          return;
        }

        let parsedUrl;

        try {
          parsedUrl = new URL(target);
        } catch (error) {
          res.status(400).send('Invalid url');
          return;
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          res.status(400).send('Unsupported protocol');
          return;
        }

        try {
          const requestId = Math.random().toString(36).slice(2);
          console.log(`[proxy-pdf:${requestId}] Fetching ${parsedUrl.href}`);
          const headers = {};
          const forwardHeaderNames = [
            'range',
            'accept',
            'accept-encoding',
            'user-agent',
            'referer',
            'accept-language',
          ];

          forwardHeaderNames.forEach(name => {
            const headerValue = req.headers?.[name];
            if (headerValue !== undefined) {
              headers[name] = headerValue;
            }
          });

          if (!headers.accept) {
            headers.accept = 'application/pdf, */*';
          }
          if (headers.referer && headers.referer.includes('/proxy-pdf')) {
            delete headers.referer;
          }

          const upstream = await axios({
            method: req.method,
            url: parsedUrl.href,
            responseType: 'stream',
            headers,
            decompress: false,
            validateStatus: () => true,
          });

          console.log(
            `[proxy-pdf:${requestId}] Upstream status ${upstream.status} content-type ${upstream.headers?.['content-type']}`
          );

          res.status(upstream.status);

          Object.entries(upstream.headers).forEach(([headerName, headerValue]) => {
            if (headerValue !== undefined) {
              res.setHeader(headerName, headerValue);
            }
          });

          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'Range');
          res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
          res.setHeader(
            'Access-Control-Expose-Headers',
            'Accept-Ranges, Content-Length, Content-Range'
          );

          if (req.method === 'HEAD') {
            res.end();
            return;
          }

          upstream.data.on('error', error => {
            console.error(`[proxy-pdf:${requestId}] Stream error`, error?.message);
            if (!res.headersSent) {
              res.status(502).send('Proxy stream error');
              return;
            }
            res.end();
          });
          upstream.data.pipe(res);
        } catch (error) {
          console.error('[proxy-pdf] Failed proxy request', error?.message || error);
          if (error.response) {
            const { status, headers, data } = error.response;
            Object.entries(headers || {}).forEach(([headerName, headerValue]) => {
              if (headerValue !== undefined) {
                res.setHeader(headerName, headerValue);
              }
            });
            res.status(status).send(data ?? 'Upstream error');
          } else {
            res.status(502).send('Failed to reach upstream resource');
          }
        }
      });
    },
  },
};
