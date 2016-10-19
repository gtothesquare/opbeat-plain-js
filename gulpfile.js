/*eslint-disable */

var fs = require('fs')
var gulp = require('gulp')
var source = require('vinyl-source-stream')
var rename = require('gulp-rename')
var browserify = require('browserify')
var buffer = require('vinyl-buffer')
var uglify = require('gulp-uglify')
var taskListing = require('gulp-task-listing')
var awspublish = require('gulp-awspublish')
var injectVersion = require('gulp-inject-version')
var derequire = require('gulp-derequire')
var es = require('event-stream')
var karma = require('karma')
var runSequence = require('run-sequence')
var webdriver = require('gulp-webdriver')
var selenium = require('selenium-standalone')
var replace = require('gulp-replace')

var connect = require('gulp-connect')

require('gulp-release-tasks')(gulp)

var jeditor = require('gulp-json-editor')

var webdriverConfig = {
  user: process.env.SAUCE_USERNAME || 'opbeat',
  key: process.env.SAUCE_ACCESS_KEY || 'de42e589-1450-41a2-8a44-90aa00c15168',
  host: process.env.SAUCE_HOST || 'ondemand.saucelabs.com',
  port: process.env.SAUCE_PORT || 80,
  baseUrl: process.env.SAUCE_BASEURL || 'http://localhost:8000'
}

// Static file server
gulp.task('examples:serve', function () {
  connect.server({
    root: ['examples', 'dist'],
    port: 7000,
    livereload: false,
    open: false
  })
})

function createBuildStream (mainFilePath, version) {
  if (typeof version !== 'string') {
    throw new Error(mainFilePath + ' Expected version as string but got:' + version)
  }

  return browserify({
    entries: [mainFilePath],
    standalone: '',
    insertGlobalVars: { define: function () { return 'undefined'; }, process: function () { return 'undefined'; } }
  })
    .bundle()
    .pipe(source(mainFilePath))
    .pipe(rename({ dirname: '' }))
    .pipe(buffer())
    .pipe(replace(
      new RegExp(RegExp.escape('%%VERSION%%'), 'g'),
      'v' + version
    ))
    .pipe(derequire())
}

function writeToDestinations (stream, dests) {
  var tasks = dests.map(function (destPath) {
    return stream.pipe(gulp.dest(versionPath))
  })
  return es.merge.apply(null, tasks)
}

function getMajorVersion () {
  var version = require('./package').version
  var majorVersion = version.match(/^(\d).(\d).(\d)/)[1]
  return majorVersion
}

gulp.task('build:release', function () {
  var version = require('./package').version
  var majorVersion = version.match(/^(\d).(\d).(\d)/)[1]

  var versionPath = './dist/cdn/' + majorVersion
  var prodPath = './dist/'

  var integrations = require('./release/integrations')

  var tasks = Object.keys(integrations).map(function (key) {
    var integration = integrations[key]
    var integrationName = key
    var mainStream = createBuildStream(integration.entry, integration.version)
      .pipe(gulp.dest(versionPath))
      .pipe(gulp.dest(prodPath))
      .pipe(gulp.dest(prodPath + integrationName))
      .pipe(rename({
        extname: '.min.js'
      }))
      .pipe(uglify())
      .pipe(gulp.dest(versionPath))
      .pipe(gulp.dest(prodPath))
      .pipe(gulp.dest(prodPath + integrationName))

    var filename = integration.entry.split('/')
    filename = filename[filename.length - 1]

    var packagejson = gulp.src(['./release/templates/*.json'])
      .pipe(jeditor({
        'name': integrationName,
        'version': integration.version,
        'main': filename,
        'description': integration.description
      }))
      .pipe(gulp.dest(prodPath + integrationName))

    return es.merge.apply(null, [mainStream, packagejson, gulp.src(['LICENSE']).pipe(gulp.dest(prodPath + integrationName))])
  })

  return es.merge.apply(null, tasks)
})

gulp.task('build', function () {
  var integrations = require('./release/integrations')

  var tasks = Object.keys(integrations).map(function (key) {
    var entry = integrations[key].entry
    var version = integrations[key].version
    return createBuildStream(entry, version)
      .pipe(gulp.dest('./dist/dev/'))
      .pipe(rename({
        extname: '.min.js'
      }))
      .pipe(uglify())
      .pipe(gulp.dest('./dist/dev/'))
  })

  return es.merge.apply(null, tasks)
})

// Development mode
gulp.task('watch', [], function (cb) {
  gulp.run(
    'build',
    'server'
  )

  // Watch JS files
  gulp.watch(['libs/**', 'src/**'], function () { runSequence('build', 'karma-run') })
  console.log('\nExample site running on http://localhost:7000/\n')
})

//
// Deploy task
//
gulp.task('deploy', ['build:release'], function () {
  // Load options from file
  awsoptions = JSON.parse(fs.readFileSync('aws.json'))

  // Hardcoded bucketname, to avoid mistakes
  awsoptions.params = {
    Bucket: 'opbeat-js-cdn'
  }

  // Create new publisher
  var publisher = awspublish.create(awsoptions)

  // Set headers
  var headers = {
    'Cache-Control': 'max-age=1800, public'
  }

  var version = require('./package').version
  var majorVersion = version.match(/^(\d).(\d).(\d)/)[1]

  var versionPath = './dist/cdn/**'

  console.warn('Uploading All files in:', versionPath)

  return gulp.src([versionPath])
    // Gzip
    .pipe(awspublish.gzip())
    // Publish files with headers
    .pipe(publisher.publish(headers))
    // Create a cache file to speed up consecutive uploads
    .pipe(publisher.cache())
    // Print upload updates to console
    .pipe(awspublish.reporter())
})

function runKarma (configFile, done) {
  var exec = require('child_process').exec

  var cmd = process.platform === 'win32' ? 'node_modules\\.bin\\karma run ' :
    'node node_modules/.bin/karma run '
  cmd += configFile
  exec(cmd, function (e, stdout) {
    // ignore errors, we don't want to fail the build in the interactive (non-ci) mode
    // karma server will print all test failures
    done()
  })
}

gulp.task('karma-run', function (done) {
  // run the run command in a new process to avoid duplicate logging by both server and runner from
  // a single process
  runKarma('karma.conf.js', done)
})

gulp.task('test', function (done) {
  new karma.Server({
    configFile: __dirname + '/karma.conf.js',
    singleRun: true
  }, done).start()
})

// Run end-to-end tests on the local machine using webdriver configuration
gulp.task('test:e2e:run', function (done) {
  gulp.src('wdio.conf.js')
    .pipe(webdriver())
    .on('error', function () {
      return process.exit(1)
    })
    .on('end', function () {
      return process.exit(0)
    })
})

gulp.task('test:e2e:phantomjs', function () {
  var failSafeStream = gulp.src('wdio.phantomjs.conf.js')
    .pipe(webdriver())
    .on('error', function () {
      console.log('Exiting process with status 1')
      process.exit(1)
    })
    .on('end', function () {
      console.log('Tests complete')
    })
  return failSafeStream
})

gulp.task('test:e2e:sauceconnect:failsafe', function () {
  var failSafeStream = gulp.src('wdio.failsafe.conf.js')
    .pipe(webdriver(webdriverConfig))
    .on('error', function () {
      console.log('Exiting process with status 1')
      process.exit(1)
    })
    .on('end', function () {
      console.log('Tests complete')
    })
  return failSafeStream
})

// Run end-to-end tests remotely in saucelabs using webdriver configuration
gulp.task('test:e2e:sauceconnect', ['test:e2e:sauceconnect:failsafe'], function () {
  var e2eStream = gulp.src('wdio.sauce.conf.js')
    .pipe(webdriver(webdriverConfig))
    .on('error', function () {
      console.log('Exiting process with status 1')
      process.exit(1)
    })
    .on('end', function () {
      console.log('Tests complete')
    })
  return e2eStream
})

// Launch sauce connect and connect
gulp.task('test:e2e:launchsauceconnect', function (done) {
  var sauceConnectLauncher = require('sauce-connect-launcher')

  var config = {
    username: webdriverConfig.user,
    accessKey: webdriverConfig.key,
    logger: console.log
  }

  var tryConnect = function (maxAttempts, currAttempts, done) {
    sauceConnectLauncher(config, function (err, sauceConnectProcess) {
      if (err) {
        console.error(err.message)
        if (currAttempts <= maxAttempts) {
          console.log('Retrying... (attempt ' + currAttempts + ' of ' + maxAttempts + ')')
          tryConnect(maxAttempts, ++currAttempts, done)
        } else {
          return process.exit(1)
        }
      } else {
        console.log('Sauce Connect ready')
        done()
      }
    })
  }

  tryConnect(3, 1, done)
})

// Serve test application
gulp.task('test:e2e:serve', function () {
  return connect.server({
    root: ['test/e2e', 'src', './'],
    port: 8000,
    livereload: false,
    open: false,
    middleware: function (connect, opt) {
      var middlewares = []
      middlewares.push(connect.favicon())
      return middlewares
    }
  })
})

function onExit (callback) {
  function exitHandler (err) {
    try {
      callback(err)
    }
    finally {
      if (err) console.log(err.stack)
    }
  }

  process.on('exit', exitHandler)

  process.on('SIGINT', exitHandler)

  process.on('uncaughtException', exitHandler)
}

function startSelenium (callback, manualStop) {
  selenium.install({ logger: console.log }, function (installError) {
    if (installError) {
      console.log('Error while installing selenium:', installError)
    }
    selenium.start(function (startError, child) {
      if (startError) {
        console.log('Error while starting selenium:', startError)
        return process.exit(1)
      } else {
        console.log('Selenium started!')
        function killSelenium () {
          child.kill()
          console.log('Just killed selenium!')
        }
        if (manualStop) {
          callback(killSelenium)
        }else {
          onExit(killSelenium)
          callback()
        }
      }
    })
  })
}

// Install and start selenium
gulp.task('test:e2e:selenium', function (done) {
  startSelenium(function () {
    done()
  })
})

gulp.task('test:e2e:start-local', ['test:e2e:serve', 'test:e2e:selenium'])

// Run all required tasks to perform remote end-to-end testing
gulp.task('test:e2e:start-sauce', function (done) {
  runSequence('build', 'test:e2e:launchsauceconnect', function () {
    console.log('All tasks completed.')
  })
})

gulp.task('test:e2e', function (done) {
  runSequence(['build', 'build:release', 'test:e2e:start-local'], ['test:e2e:phantomjs', 'test:e2e:launchsauceconnect'], 'test:e2e:sauceconnect', function (err) {
    if (err) {
      return taskFailed(err)
    } else {
      return sequenceSucceeded(done)
    }
  })
})

function taskFailed (err) {
  var exitCode = 2
  console.log('[ERROR] gulp build task failed', err)
  console.log('[FAIL] gulp build task failed - exiting with code ' + exitCode)
  return process.exit(exitCode)
}

function sequenceSucceeded (done) {
  console.log('All tasks completed.')
  done()
  return process.exit(0)
}

gulp.task('test:unit:sauce', function (done) {
  runSequence(['build', 'test:e2e:launchsauceconnect'], 'test', function (err) {
    if (err) {
      return taskFailed(err)
    } else {
      return sequenceSucceeded(done)
    }
  })
})

gulp.task('watch:e2e', ['e2e-serve', 'selenium-start'], function (done) {
  gulp.watch(['test/e2e/**'], function () {
    runSequence('test:e2e')
  })
})

gulp.task('default', taskListing)
