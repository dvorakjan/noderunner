exports = module.exports = Gui;

function Gui(db, nconf, logger, queues) {
  this.db = db
  this.nconf = nconf
  this.logger = logger
  this.queues = queues

  this.timeouts = {};
  this.timeoutsOnEndTime = {};
}


Gui.prototype.batch = function(id, fn, timeout) {
  var self = this;
  if (typeof timeout == 'undefined') timeout = self.nconf.get('gui:batchTimeout');

  if (typeof self.timeouts[id] == 'undefined') {
    self.timeouts[id] = {};
    self.timeouts[id].onEnd = function(){};
    self.timeouts[id].timeout = setTimeout(function(){
      self.timeouts[id].onEnd();
      delete self.timeouts[id];

      // zaznamenat cas behu onEnd fce podle ID
      self.timeoutsOnEndTime[id] = new Date().getTime();
    }, timeout);

    // TODO pokud now()-onEndTime<timeout
    if (typeof self.timeoutsOnEndTime[id] == 'undefined' || ((new Date().getTime() - self.timeoutsOnEndTime[id]) > timeout)) {
      fn();
    }
    delete self.timeoutsOnEndTime[id];
  } else {
    self.timeouts[id].onEnd = fn;
  }
}

Gui.prototype._initSocket = function () {
  var express = require('express');
  var app = express();
  var listener = app.listen(8001);
  app.use('/', express.static('public'));
  return require('socket.io')(listener);
}

Gui.prototype.run = function () {
  var self = this;
  var io   = self._initSocket();

  self.logger.verbose('socket.io listens on ' + 8001);

  // on user connected
  io.on('connection', function (socket) {
    self.logger.info('GUI: user ' + socket.id + ' connected');
    socket.queueFilters = {'immediate':{}, 'history':{}, 'planned': {}};

    // send initial data
    Object.keys(self.queues).forEach(function (queueName) {
      self.updateClientQueue(queueName, socket);
    });

    // send initial data to top number indicators
    self.emit(socket, 'freeThreadsCountChanged', (self.queues.immediate.maxThreadsCount - self.queues.immediate.activeThreadsCount)+' / 4');
    self.emit(socket, 'runningCountChanged', self.queues.immediate.activeThreadsCount);

    // bind to user events
    socket.on('rerun', function(params){
      self.logger.verbose('rerun event detected', params);
      self.queues.history.rerunJob(params.id, params.queue);
    })

    socket.on('setQueueFilter', function(params) {
      socket.queueFilters[params.queue] = params.filter;
      self.updateClientQueue(params.queue, socket);
    })
  });

  // for every queue bind job change updates
  Object.keys(self.queues).forEach(function (queueName) {
    self.queues[queueName].on('jobChanged', function (params) { // {changes:..., newDocument:...}

      io.sockets.sockets.forEach(function(socket) {
        // TODO temporary solution - complete update instead of single document only
        self.updateClientQueue(queueName, socket);

        // hack beacaouse of showing done immediate jobs in history table
        if (queueName == 'immediate') {
          self.updateClientQueue('history', socket);
        }
      });
    });
  });

  // update top numbers indicators
  self.queues.immediate.on('runningCountChanged', function (params) {
    self.batch('runningCountChanged', function() {
      io.sockets.sockets.forEach(function (socket) {
        self.emit(socket, 'runningCountChanged', params);
        self.emit(socket, 'freeThreadsCountChanged', self.queues.immediate.maxThreadsCount - params + ' / ' + self.queues.immediate.maxThreadsCount);
      });
    });
  });
  self.queues.history.on('movedToHistory', function (params) { // {oldDocument:..., newDocument:...}
    self.batch('movedToHistory', function() {
      io.sockets.sockets.forEach(function (socket) {
        self.emit(socket, 'movedToHistory', params, params.changes);

        // TODO prehodit job v clientovi do jine fronty bez full updatu
        self.updateClientQueue('immediate', socket);
        self.updateClientQueue('history', socket);
      });
    });
  });
  self.queues.planned.on('copiedToImmediate', function (params) { // {oldDocument:..., newDocument:...}
    self.batch('copiedToImmediate', function() {
      io.sockets.sockets.forEach(function (socket) {
        self.emit(socket, 'copiedToImmediate', params, params.changes);

        // TODO prehodit job v clientovi do jine fronty bez full updatu
        self.updateClientQueue('immediate', socket);
      });
    });
  });
  self.queues.history.on('rerunDone', function (params) { // {oldDocument:..., newDocument:...}
    self.batch('rerunDone', function() {
      io.sockets.sockets.forEach(function (socket) {
        self.emit(socket, 'rerunDone', params, params.changes);

        // TODO prehodit job v clientovi do jine fronty bez full updatu
        self.updateClientQueue('immediate', socket);
        self.updateClientQueue('history', socket);
      });
    });
  });


  return this;
}

Gui.prototype.updateClientQueue = function(queueName, socket) {
  var self = this;

  self.batch(queueName, function(){

    self.queues[queueName].getJobs(function(data){

      data = data.map(function(job){job.queue = queueName; return job;});

      switch (queueName) {

        case 'immediate':
          self.emit(socket, 'waitingCountChanged', data.reduce(function(sum, job){
            return sum + (job.status == 'planed' ? 1 : 0);
          }, 0));

          // dont show done jobs in immediate
          data = data.filter(function(job) { return job.status != 'success' && job.status != 'error'; });
          self.emit(socket, 'initial' + queueName + 'Data', data);
          break;

        case 'planned':

          self.emit(socket, 'plannedCountChanged', data.length);
          self.emit(socket, 'initial' + queueName + 'Data', data);
          break;

        case 'history':
          self.queues.history.getJobsCount(function(count){
            self.emit(socket, 'historyCountChanged', count);
          });

          // prepend done jobs from immediate
          self.queues.immediate.getJobs(function(immediateJobs) {
            immediateJobs = immediateJobs.filter(function(job) { return job.status == 'success' || job.status == 'error'; });
            immediateJobs = immediateJobs.map(function(job){job.queue = 'immediate'; return job;});
            self.emit(socket, 'initial' + queueName + 'Data', immediateJobs.concat(data));
          }, socket.queueFilters.history)
          break;
      }

    }, socket.queueFilters[queueName]);
  });
}

Gui.prototype.emit = function (socket, action, params, logDetails) {
  this.logger.verbose('GUI: emit event ' + action, logDetails ? logDetails : '')
  socket.emit(action, params);
}


Gui.prototype.stop = function () {
  this.logger.info('GUI: stopped');
}
