exports = module.exports = Gui;

var _ = require('lodash');

function Gui(db, nconf, logger, queues, watchdog) {
    this.db = db
    this.nconf = nconf
    this.logger = logger
    this.queues = queues
    this.watchdog = watchdog

    this.timeouts = {};
    this.timeoutsOnEndTime = {};
}

Gui.prototype._init = function () {
    var express = require('express');
    var bodyParser = require('body-parser');
    var app = express();
    var listener = app.listen(8001);
    app.use('/', express.static('public'));
    
    app.post('/queue/:queue', bodyParser.json(), (req, res) => {
        if (['::1', '127.0.0.1'].includes(req.ip)) {
            this.db.collection(req.params.queue).insert(req.body, (err) => {
                err && (res.statusCode = 500)
                res.end()
            })
        } else {   
            res.statusCode = 401
            res.end()
        }
    })

    return require('socket.io')(listener);
}

Gui.prototype.run = function () {
    var self = this;
    self.io = self._init();

    self.logger.info('GUI socket.io listens on ' + 8001);

    // INCOMING EVENTS
    // Immediate -- runningJobsList, runningCountChanged, jobFetched, jobCompleted, jobStarted, historyCountIncreased, waitingCountDecreased
    // History --  historyCountDecreased
    // Planned -- waitingCountIncreased

    // on user connected
    self.io.on('connection', function (socket) {
        self.logger.info('GUI: user ' + socket.id + ' connected');

        socket.on('error', function(e) {
            self.logger.error(e);
        })

        self.updateRunningList(socket);

        self.watchdog.loadThreadsStats(self.nconf.get('gui:threadsStatsLength')/1000, function (data) {
            self.emit(socket, 'threadsStats', data);
        });

        self.emit(socket, 'threadsCount', self.queues.immediate.getThreads().length);

        self.queues.history.getJobsCount(function(cnt){
            self.emit(socket, 'historyCount', cnt);
        });

        self.queues.immediate.getWaitingJobsCount(function(cnt){
            self.emit(socket, 'waitingCount', cnt);
        });

        self.queues.planned.getJobsCount(function(cnt){
            self.emit(socket, 'plannedCount', cnt);
        });

        socket.on('requestQueueData', function(params) {
            self.logger.verbose('GUI: request queue data', params)
            try {
                self.updateQueue(params.queue, params.filter, socket);
            } catch (e) {
                self.logger.error(e);
            }
        });

        socket.on('rerun', function (params) {
            self.logger.verbose('rerun event detected', params);
            self.emitToAll('waitingCountIncreased', 1);
            self.queues.history.rerunJob(params.id, params.queue);
        });

    });

    self.queues.immediate.on('jobFetched', function (job) {
        self.emitToAll('jobFetched', job);
    });

    self.queues.immediate.on('jobCompleted', function (job) {
        self.emitToAll('jobCompleted', job);
    });

    self.queues.immediate.on('jobStarted', function (job) {
        self.emitToAll('jobStarted', job);
    });

    self.queues.planned.on('waitingCountIncreased', function (diff) {
        self.emitToAll('waitingCountIncreased', diff);
        self.updateWaitingCount();
    });

    self.queues.immediate.on('waitingCountDecreased', function (diff) {
        self.emitToAll('waitingCountDecreased', diff);
        self.updateWaitingCount();
    });

    self.queues.immediate.on('historyCountIncreased', function (diff) {
        self.emitToAll('historyCountIncreased', diff);
    });

    self.queues.history.on('historyCountDecreased', function (diff) {
        self.emitToAll('historyCountDecreased', diff);
    });

    self.watchdog.on('newThreadsStat', function (data) {
        self.emitToAll('newThreadsStat', data);
    });

    self.queues.history.on('rerunDone', function () {
        self.updateWaitingCount();
    });

    return this;
}

Gui.prototype.updateWaitingCount = _.debounce(function() {
    var self = this;
    if (self.io.sockets.sockets.length > 0) {
        console.log('THROTTLED updateWaitingCount')
        self.queues.immediate.getWaitingJobsCount(function (cnt) {
            self.emitToAll('waitingCount', cnt);
        });
    }
}, 3000);

Gui.prototype.updateRunningList = function (socket) {
    var self = this;

    self.queues.immediate.getJobs(function (data) {
        self.emit(socket, 'runningJobsList', data);
    }, {
        $or: [
            {status: self.nconf.get('statusAlias:fetched')},
            {status: self.nconf.get('statusAlias:running')}
        ]
    });
}


Gui.prototype.updateQueue = function (queueName, filter, socket) {
    var self = this;

    if (typeof filter.host != 'undefined') {
        filter.host = new RegExp(filter.host);
    }

    if (typeof filter.job != 'undefined') {
        filter.job = new RegExp(filter.job);
    }

    if (typeof filter.output != 'undefined') {
        filter.output = new RegExp(filter.output);
    }

    if (typeof filter.schedule != 'undefined') {
        filter.schedule = new RegExp(filter.schedule);
    }

    self.queues[queueName].getJobs(function (data) {

        data = data.map(function (job) {
            job.queue = queueName;
            return job;
        });

        switch (queueName) {

            case 'immediate':
                // show only running jobs
                data = data.filter(function (job) {
                    return job.status == 'planed';
                });
                self.emit(socket, queueName + 'QueueData', data);
                break;

            case 'planned':
                self.emit(socket, queueName + 'QueueData', data);
                break;

            case 'history':
                console.log(data)
                // prepend done jobs from immediate
                self.queues.immediate.getJobs(function (immediateJobs) {
                    immediateJobs = immediateJobs.filter(function (job) {
                        return job.status == 'success' || job.status == 'error';
                    });

                    immediateJobs = immediateJobs.map(function (job) {
                        job.queue = 'immediate';
                        return job;
                    });

                    var jobs = immediateJobs.concat(data);
                    self.emit(socket, queueName + 'QueueData', jobs);
                }, filter)
                break;
        }

    }, filter);
}

Gui.prototype.emitToAll = function(action, params) {
    this.logger.debug('GUI: emitToAll event ' + action)
    this.io.emit(action, params);
}

Gui.prototype.emit = function (socket, action, params, logDetails) {
    this.logger.debug('GUI: emit event ' + action, logDetails ? logDetails : '')
    socket.emit(action, params);
}


Gui.prototype.stop = function () {
    this.io.close();
    this.logger.info('GUI: stopped');
}

