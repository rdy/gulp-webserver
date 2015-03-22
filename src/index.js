var through = require('through2');
var gutil = require('gulp-util');
var http = require('http');
var https = require('https');
var connect = require('connect');
var connectLivereload = require('connect-livereload');
var proxy = require('proxy-middleware');
var tinyLr = require('tiny-lr');
var fs = require('fs');
var path = require('path');
var open = require('open');
var url = require('url');
var extend = require('node.extend');
var enableMiddlewareShorthand = require('./enableMiddlewareShorthand');
var isarray = require('isarray');
var mime = require('mime');
var prettyBytes = require('pretty-bytes');
var compression = require('compression');

function directoryListing(files) {
  var types = {
    eot: 'Fonts',
    woff: 'Fonts',
    ttf: 'Fonts',
    otf: 'Fonts',
    svg: 'Fonts',
    png: 'Images',
    jpg: 'Images',
    css: 'CSS',
    js: 'JavaScript',
    map: 'Sourcemaps'
  };

  function getType(p) {
    return types[path.extname(p).substring(1)] || 'Others';
  }

  function sortF(a, b) {
    var ext = getType(a).localeCompare(getType(b));
    if (ext !== 0) return ext;
    var dir = path.dirname(a).localeCompare(path.dirname(b));
    if (dir !== 0) return dir;
    return a.localeCompare(b);
  }

  return function(req, res, next) {
    if (req.url != '/') return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.write('<html style="font-family: \'open sans\', \'source sans pro\', sans-serif; font-size: 14px; line-height: 20px; padding: 0 5% 5%"><div>');
    var lastType = null;
    var lastDir = null;
    Object.keys(files).sort(sortF).forEach(function(p) {
      var type = getType(p);
      var dir = path.dirname(p);
      var base = path.basename(p);
      if (type !== lastType) {
        res.write('</div><div style="display: inline-block; vertical-align: top; width: 23%; margin: 0 1%"><h2>' + type + '</h2>');
        lastType = type;
        lastDir = null;
      }
      if (dir !== lastDir) {
        res.write('<h4>' + dir + '</h4>');
        lastDir = dir;
      }
      res.write('<div style="margin-left: 5%; position: relative;"><a style="text-decoration:none" href="' + p + '">' + base + '</a> <span style="color: #999; font-size: 12px; position: absolute; right: 0; top: 2px">' + prettyBytes(files[p].contents.toString().length) + '</span></div>');
    });
    res.write('</div></html>');
    res.end();
  };
}

function serveStream(files) {
  return function(req, res) {
    var p = url.parse(req.url).pathname;
    if (!files[p]) {
      gutil.log(gutil.colors.red('Not found'), gutil.colors.cyan(p));
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.write('Not found');
      res.end();
      return;
    }
    var body = files[p].contents;
    res.setHeader('Content-Type', mime.lookup(p) + '; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.write(body);
    res.end();
  };
}

module.exports = function(options) {

  var defaults = {

    /**
     *
     * BASIC DEFAULTS
     *
     **/

    host: 'localhost',
    port: 8000,
    https: false,
    open: false,

    /**
     *
     * MIDDLEWARE DEFAULTS
     *
     * NOTE:
     *  All middleware should defaults should have the 'enable'
     *  property if you want to support shorthand syntax like:
     *
     *    webserver({
     *      livereload: true
     *    });
     *
     */

    // Middleware: Livereload
    livereload: {
      enable: false,
      port: 35729,
      filter: function (filename) {
        if (filename.match(/node_modules/)) {
          return false;
        } else { return true; }
      }
    },

    // Middleware: Directory listing
    // For possible options, see:
    //  https://github.com/expressjs/serve-index
    directoryListing: {
      enable: false,
      path: './',
      options: undefined
    },

    // Middleware: Compression
    compression: {
      enable: false,
      options: undefined
    },

    // Middleware: Proxy
    // For possible options, see:
    //  https://github.com/andrewrk/connect-proxy
    proxies: []

  };

  // Deep extend user provided options over the all of the defaults
  // Allow shorthand syntax, using the enable property as a flag
  var config = enableMiddlewareShorthand(defaults, options, [
    'directoryListing',
    'livereload',
    'compression'
  ]);

  if (typeof config.open === 'string' && config.open.length > 0 && config.open.indexOf('http') !== 0) {
    // ensure leading slash if this is NOT a complete url form
    config.open = (config.open.indexOf('/') !== 0 ? '/' : '') + config.open;
  }

  var app = connect();

  var openInBrowser = function() {
    if (config.open === false) return;
    if (typeof config.open === 'string' && config.open.indexOf('http') === 0) {
      // if this is a complete url form
      open(config.open);
      return;
    }
    open('http' + (config.https ? 's' : '') + '://' + config.host + ':' + config.port + (typeof config.open === 'string' ? config.open : ''));
  };

  var lrServer;

  if (config.livereload.enable) {

    app.use(connectLivereload({
      port: config.livereload.port
    }));

    if (config.https) {
      if (config.https.pfx) {
        lrServer = tinyLr({
          pfx: fs.readFileSync(config.https.pfx),
          passphrase: config.https.passphrase
        });
      }
      else {
        lrServer = tinyLr({
          key: fs.readFileSync(config.https.key || __dirname + '/../ssl/dev-key.pem'),
          cert: fs.readFileSync(config.https.cert || __dirname + '/../ssl/dev-cert.pem')
        });
      }
    } else {
      lrServer = tinyLr();
    }

    lrServer.listen(config.livereload.port, config.host);

  }

  // middlewares
  if (typeof config.middleware === 'function') {
    app.use(config.middleware);
  } else if (isarray(config.middleware)) {
    config.middleware
      .filter(function(m) { return typeof m === 'function'; })
      .forEach(function(m) {
        app.use(m);
      });
  }

  // Proxy requests
  for (var i = 0, len = config.proxies.length; i < len; i++) {
    var proxyoptions = url.parse(config.proxies[i].target);
    if (config.proxies[i].hasOwnProperty('options')) {
      extend(proxyoptions, config.proxies[i].options);
    }
    app.use(config.proxies[i].source, proxy(proxyoptions));
  }

  var files = {};

  if (config.directoryListing.enable) {
    app.use(directoryListing(files));
  }

  if (config.compression.enable) {
    app.use(compression(config.compression.options));
  }

  app.use(serveStream(files));

  // Create server
  var stream = through.obj(function(file, enc, callback) {
    if (file.isStream()) {
      return callback(new Error('Streams are not supported'));
    }

    var url = '/' + path.relative(file.base, file.path);
    files[url] = file;

    if (config.livereload.enable) {
      lrServer && lrServer.changed({
        body: {
          files: file.path
        }
      });
    }

    this.push(file);
    callback();
  });

  var webserver;

  if (config.https) {
    var opts;

    if (config.https.pfx) {
      opts = {
        pfx: fs.readFileSync(config.https.pfx),
        passphrase: config.https.passphrase
      };
    } else {
      opts = {
        key: fs.readFileSync(config.https.key || __dirname + '/../ssl/dev-key.pem'),
        cert: fs.readFileSync(config.https.cert || __dirname + '/../ssl/dev-cert.pem')
      };
    }
    webserver = https.createServer(opts, app).listen(config.port, config.host, openInBrowser);
  } else {
    webserver = http.createServer(app).listen(config.port, config.host, openInBrowser);
  }

  gutil.log('Webserver started at', gutil.colors.cyan('http' + (config.https ? 's' : '') + '://' + config.host + ':' + config.port));

  stream.on('kill', function() {

    webserver.close();

    if (config.livereload.enable) {
      lrServer.close();
    }

  });

  return stream;

};
