const assert         = require('assert');
const debug          = require('./debug');
const File           = require('fs');
const Path           = require('path');
const Matcher        = require('./matcher');
const jsStringEscape = require('js-string-escape');


function mkpathSync(pathname) {
  if (File.existsSync(pathname))
    return;
  const parent = Path.dirname(pathname);
  if (File.existsSync(parent))
    File.mkdirSync(pathname);
  else {
    mkpathSync(parent);
    File.mkdirSync(pathname);
  }
}


// Parse headers from headerLines.  Optional argument `only` is an array of
// regular expressions; only headers matching one of these expressions are
// parsed.  Returns a object with name/value pairs.
function parseHeaders(filename, headerLines, only = null) {
  const headers = Object.create(null);
  for (let line of headerLines) {
    if (line === '')
      continue;
    let [name, value] = line.match(/^(.*?)\:\s+(.*)$/).slice(1);
    if (only && !match(name, only))
      continue;

    const key  = (name || '').toLowerCase();
    value = (value || '').trim().replace(/^"(.*)"$/, '$1');
    if (Array.isArray(headers[key]))
      headers[key].push(value);
    else if (headers[key])
      headers[key] = [headers[key], value];
    else
      headers[key] = value;
  }
  return headers;
}


function parseRequest(filename, request, requestHeaders) {
  assert(request, `${filename} missing request section`);
  const [ methodAndPath, ...headerLines ] = request.split(/\n/);
  let method;
  let path;
  let rawRegexp;
  let regexp;
  if (/\sREGEXP\s/.test(methodAndPath)) {
    [ method, rawRegexp ]  = methodAndPath.split(' REGEXP ');
    const [ inRegexp, flags ] = rawRegexp.match(/^\/(.+)\/(i|m|g)?$/).slice(1);
    regexp = new RegExp(inRegexp, flags || '');
  } else
    [ method, path ] = methodAndPath.split(/\s/);
  assert(method && (path || regexp), `${filename}: first line must be <method> <path>`);
  assert(/^[a-zA-Z]+$/.test(method), `${filename}: method not valid`);
  const headers = parseHeaders(filename, headerLines, requestHeaders);
  const body    = headers.body;
  delete headers.body;
  const url = path || regexp;
  return { url, method, headers, body };
}


function parseResponse(filename, response, body) {
  if (response) {
    const [ statusLine, ...headerLines ] = response.split(/\n/);
    const newFormat     = statusLine.match(/HTTP\/(\d\.\d)\s+(\d{3})\s*(.*)/);
    const version       = newFormat[1];
    const statusCode    = parseInt(newFormat[2], 10);
    const statusMessage = newFormat[3].trim();
    const headers       = parseHeaders(filename, headerLines);
    const rawHeaders    = headerLines.reduce(function(raw, header) {
      const [name, value] = header.split(/:\s+/);
      raw.push(name);
      raw.push(value);
      return raw;
    }, []);
    return { statusCode, statusMessage, version, headers, rawHeaders, body, trailers: {}, rawTrailers: [] };
  }
}


function readAndInitialParseFile(filename) {
  const buffer  = File.readFileSync(filename);
  const parts   = buffer.toString('utf8').split('\n\n');
  if (parts.length > 2) {
    const parts0  = new Buffer(parts[0], 'utf8');
    const parts1  = new Buffer(parts[1], 'utf8');
    const body    = buffer.slice(parts0.length + parts1.length + 4);
    return [ parts[0], parts[1], body ];
  } else
    return [ parts[0], parts[1], '' ];
}


// Write headers to the File object.  Optional argument `only` is an array of
// regular expressions; only headers matching one of these expressions are
// written.
function writeHeaders(file, headers, only = null) {
  for (let name in headers) {
    let value = headers[name];
    if (only && !match(name, only))
      continue;
    if (Array.isArray(value))
      for (let item of value)
        file.write(`${name}: ${item}\n`);
    else
      file.write(`${name}: ${value}\n`);
  }
}


// Returns true if header name matches one of the regular expressions.
function match(name, regexps){
  for (let regexp of regexps)
    if (regexp.test(name))
      return true;
  return false;
}

module.exports = class Catalog {

  constructor(settings) {
    this.settings = settings;
    // We use this to cache host/host:port mapped to array of matchers.
    this.matchers = {};
    this._basedir = Path.resolve('fixtures');
  }

  getFixturesDir() {
    return this._basedir;
  }

  setFixturesDir(dir) {
    this._basedir = Path.resolve(dir);
    this.matchers = {};
  }

  find(host) {
    let matcherKey = host;

    if (this.settings.hostSuffix) {
      matcherKey += `.${this.settings.hostSuffix}`; 
    }

    // Return result from cache.
    const matchers = this.matchers[matcherKey];
    if (matchers)
      return matchers;

    // Start by looking for directory and loading each of the files.
    // Look for host-port (windows friendly) or host:port (legacy)
    let pathname = `${this.getFixturesDir()}/${matcherKey.replace(':', '-')}`;
    if (!File.existsSync(pathname))
      pathname = `${this.getFixturesDir()}/${matcherKey}`;
    if (!File.existsSync(pathname))
      return null;

    const newMatchers = this.matchers[matcherKey] || [];
    this.matchers[matcherKey] = newMatchers;

    const stat = File.statSync(pathname);
    if (stat.isDirectory()) {
      const files = File.readdirSync(pathname);
      for (let file of files) {
        let mapping = this._read(`${pathname}/${file}`);
        newMatchers.push(Matcher.fromMapping(host, mapping));
      }
    } else {
      const mapping = this._read(pathname);
      newMatchers.push(Matcher.fromMapping(host, mapping));
    }

    return newMatchers;
  }

  save(host, request, response, callback) {
    let matcherKey = host;

    if (this.settings.hostSuffix) {
      matcherKey += `.${this.settings.hostSuffix}`; 
    }

    const matcher = Matcher.fromMapping(host, { request, response });
    const matchers = this.matchers[matcherKey] || [];
    matchers.push(matcher);
    const requestHeaders = this.settings.headers;

    const uid = this.settings.customFileNameHeader ? request.headers[this.settings.customFileNameHeader] : `${ Date.now() }${ Math.floor(Math.random() * 100000) }`;
    const tmpfile   = `${this.getFixturesDir()}/node-replay.${uid}`;
    const pathname  = `${this.getFixturesDir()}/${matcherKey.replace(':', '-')}`;

    debug(`Creating ${pathname}`);
    try {
      mkpathSync(pathname);
    } catch (error) {
      setImmediate(function() {
        callback(error);
      });
      return;
    }

    const filename = `${pathname}/${uid}`;
    try {
      const file = File.createWriteStream(tmpfile, { encoding: 'utf-8' });
      file.write(`${request.method.toUpperCase()} ${request.url.path || '/'}\n`);
      writeHeaders(file, request.headers, requestHeaders);
      if (request.body) {
        let body = '';
        for (let chunks of request.body)
          body += chunks[0];
        writeHeaders(file, { body: jsStringEscape(body) });
      }
      file.write('\n');
      // Response part
      file.write(`HTTP/${response.version || '1.1'} ${response.statusCode || 200} ${response.statusMessage}\n`);
      writeHeaders(file, response.headers);
      file.write('\n');
      for (let part of response.body)
        file.write(part[0], part[1]);
      file.end(function() {
        File.rename(tmpfile, filename, callback);
      });
    } catch (error) {
      callback(error);
    }
  }

  _read(filename) {
    const [request, response, part] = readAndInitialParseFile(filename);
    const body = [[part, undefined]];
    return {
      request:  parseRequest(filename, request, this.settings.headers),
      response: parseResponse(filename, response, body)
    };
  }

};

