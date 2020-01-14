import ensureArray from 'ensure-array';
import _cloneDeep from 'lodash/cloneDeep';
import _find from 'lodash/find';
import _get from 'lodash/get';
import _isPlainObject from 'lodash/isPlainObject';
import _noop from 'lodash/noop';
import _reverse from 'lodash/reverse';
import _sortBy from 'lodash/sortBy';
import _uniq from 'lodash/uniq';
import SerialPort from 'serialport';
import socketIO from 'socket.io';
import socketioJwt from 'socketio-jwt';
import settings from './config/settings';
import {
    CONNECTION_TYPE_SERIAL,
    CONNECTION_TYPE_SOCKET,
} from './constants/connection';
import * as accessControl from './lib/access-control';
import EventTrigger from './lib/EventTrigger';
import logger from './lib/logger';
import { toIdent as toSerialIdent } from './lib/SerialConnection';
import { toIdent as toSocketIdent } from './lib/SocketConnection';
import GrblController from './controllers/Grbl/GrblController';
import MarlinController from './controllers/Marlin/MarlinController';
import SmoothieController from './controllers/Smoothie/SmoothieController';
import TinyGController from './controllers/TinyG/TinyGController';
import { GRBL } from './controllers/Grbl/constants';
import { MARLIN } from './controllers/Marlin/constants';
import { SMOOTHIE } from './controllers/Smoothie/constants';
import { G2CORE, TINYG } from './controllers/TinyG/constants';
import controllers from './store/controllers';
import serviceContainer from './service-container';

const shellCommand = serviceContainer.resolve('shellCommand');
const userStore = serviceContainer.resolve('userStore');

const log = logger('service-engine');

// Case-insensitive equality checker.
// @param {string} str1 First string to check.
// @param {string} str2 Second string to check.
// @return {boolean} True if str1 and str2 are the same string, ignoring case.
const caseInsensitiveEquals = (str1, str2) => {
    str1 = str1 ? (str1 + '').toUpperCase() : '';
    str2 = str2 ? (str2 + '').toUpperCase() : '';
    return str1 === str2;
};

const isValidController = (controller) => (
    // Grbl
    caseInsensitiveEquals(GRBL, controller) ||
    // Marlin
    caseInsensitiveEquals(MARLIN, controller) ||
    // Smoothie
    caseInsensitiveEquals(SMOOTHIE, controller) ||
    // g2core
    caseInsensitiveEquals(G2CORE, controller) ||
    // TinyG
    caseInsensitiveEquals(TINYG, controller)
);

class ServiceEngine {
    controllerClass = {};

    listener = {
        taskStart: (...args) => {
            if (this.io) {
                this.io.emit('task:start', ...args);
            }
        },
        taskFinish: (...args) => {
            if (this.io) {
                this.io.emit('task:finish', ...args);
            }
        },
        taskError: (...args) => {
            if (this.io) {
                this.io.emit('task:error', ...args);
            }
        },
        configChange: (...args) => {
            if (this.io) {
                this.io.emit('config:change');
            }
        }
    };

    server = null;

    io = null;

    sockets = [];

    // Event Trigger
    event = new EventTrigger((event, trigger, commands) => {
        log.debug(`EventTrigger: event=${JSON.stringify(event)}, trigger=${JSON.stringify(trigger)}, commands=${JSON.stringify(commands)}`);
        if (trigger === 'system') {
            shellCommand.spawn(commands);
        }
    });

    // @param {object} server The HTTP server instance.
    // @param {string} controller Specify CNC controller.
    start(server, controller = '') {
        // Fallback to an empty string if the controller is not valid
        if (!isValidController(controller)) {
            controller = '';
        }

        // Grbl
        if (!controller || caseInsensitiveEquals(GRBL, controller)) {
            this.controllerClass[GRBL] = GrblController;
        }
        // Marlin
        if (!controller || caseInsensitiveEquals(MARLIN, controller)) {
            this.controllerClass[MARLIN] = MarlinController;
        }
        // Smoothie
        if (!controller || caseInsensitiveEquals(SMOOTHIE, controller)) {
            this.controllerClass[SMOOTHIE] = SmoothieController;
        }
        // TinyG / G2core
        if (!controller || caseInsensitiveEquals(G2CORE, controller) || caseInsensitiveEquals(TINYG, controller)) {
            this.controllerClass[TINYG] = TinyGController;
        }

        if (Object.keys(this.controllerClass).length === 0) {
            throw new Error(`No valid CNC controller specified (${controller})`);
        }

        const availableControllers = Object.keys(this.controllerClass);
        log.debug(`Available controllers: ${availableControllers}`);

        this.stop();

        userStore.on('change', this.listener.configChange);

        shellCommand.on('start', this.listener.taskStart);
        shellCommand.on('finish', this.listener.taskFinish);
        shellCommand.on('error', this.listener.taskError);

        // System Trigger: Startup
        this.event.trigger('startup');

        this.server = server;
        this.io = socketIO(this.server, {
            serveClient: true,
            path: '/socket.io'
        });

        this.io.use(socketioJwt.authorize({
            secret: settings.secret,
            handshake: true
        }));

        this.io.use((socket, next) => {
            try {
                const ipaddr = socket.handshake.address;
                const user = socket.decoded_token || {};

                { // IP address access control
                    const pass = accessControl.isAllowedIPAddress(ipaddr);
                    if (!pass) {
                        throw new Error(`Unauthorized Error: Client with IP address ${ipaddr} is not allowed to access the server`);
                    }
                }

                { // validate the user
                    const { id = null, name = null } = { ...user };
                    const users = ensureArray(userStore.get('users'));
                    const enabledUsers = users
                        .filter(user => _isPlainObject(user))
                        .map(user => ({
                            ...user,
                            // defaults to true if not explicitly initialized
                            enabled: (user.enabled !== false)
                        }))
                        .filter(user => user.enabled);
                    if ((enabledUsers.length > 0) && !_find(enabledUsers, { id: id, name: name })) {
                        throw new Error('Unauthorized Error: User is not available');
                    }
                }
            } catch (err) {
                log.warn(err);
                next(err);
                return;
            }

            next();
        });

        this.io.on('connection', (socket) => {
            const address = socket.handshake.address;
            const user = socket.decoded_token || {};
            log.debug(`New connection from ${address}: id=${socket.id}, user.id=${user.id}, user.name=${user.name}`);

            // Add to the socket pool
            this.sockets.push(socket);

            socket.emit('startup', {
                availableControllers: Object.keys(this.controllerClass)
            });

            socket.on('disconnect', () => {
                log.debug(`Disconnected from ${address}: id=${socket.id}, user.id=${user.id}, user.name=${user.name}`);

                Object.keys(controllers).forEach(ident => {
                    const controller = controllers[ident];
                    if (!controller) {
                        return;
                    }
                    controller.removeSocket(socket);
                });

                // Remove from socket pool
                this.sockets.splice(this.sockets.indexOf(socket), 1);
            });

            // Gets a list of available serial ports
            // @param {function} callback The error-first callback.
            socket.on('getPorts', async (callback = _noop) => {
                if (typeof callback !== 'function') {
                    callback = _noop;
                }

                log.debug(`socket.getPorts(): id=${socket.id}`);

                try {
                    const availablePorts = ensureArray(await SerialPort.list());
                    const userDefinedPorts = ensureArray(userStore.get('ports', []));
                    const occupiedPorts = [];

                    Object.keys(controllers).forEach(ident => {
                        const controller = controllers[ident];

                        const connectionType = _get(controller, 'connection.type');
                        if (connectionType !== CONNECTION_TYPE_SERIAL) {
                            return;
                        }

                        const path = _get(controller, 'connection.options.path');
                        if (!path) {
                            return;
                        }

                        occupiedPorts.push({ path: path });
                    });

                    const ports = [].concat(availablePorts).concat(userDefinedPorts)
                        .filter(port => !!port.path)
                        .map(port => {
                            const { path, manufacturer } = { ...port };
                            const connected = !!_find(occupiedPorts, { path: path });

                            return {
                                path,
                                manufacturer,
                                connected,
                            };
                        });

                    callback(null, ports);
                } catch (e) {
                    log.error(e.message);
                    callback(e);
                }
            });

            // Gets a list of supported baud rates
            // @param {function} callback The error-first callback.
            socket.on('getBaudRates', (callback = _noop) => {
                if (typeof callback !== 'function') {
                    callback = _noop;
                }

                const defaultBaudRates = [
                    250000,
                    115200,
                    57600,
                    38400,
                    19200,
                    9600,
                    2400,
                ];
                const customBaudRates = ensureArray(userStore.get('baudRates'));
                const baudRates = _reverse(_sortBy(_uniq(customBaudRates.concat(defaultBaudRates))));
                callback(null, baudRates);
            });

            socket.on('open', (controllerType = GRBL, connectionType = CONNECTION_TYPE_SERIAL, connectionOptions, callback = _noop) => {
                if (typeof callback !== 'function') {
                    callback = _noop;
                }

                connectionOptions = { ...connectionOptions };

                log.debug(`socket.open(${JSON.stringify(controllerType)}, ${JSON.stringify(connectionType)}, ${JSON.stringify(connectionOptions)}): id=${socket.id}`);

                let ident = '';

                if (connectionType === CONNECTION_TYPE_SERIAL) {
                    ident = toSerialIdent(connectionOptions);
                } else if (connectionType === CONNECTION_TYPE_SOCKET) {
                    ident = toSocketIdent(connectionOptions);
                }

                if (!ident) {
                    const error = 'Invalid connection identifier';
                    log.error(error);
                    callback(new Error(error));
                    return;
                }

                let controller = controllers[ident];
                if (!controller) {
                    const Controller = this.controllerClass[controllerType];
                    if (!Controller) {
                        const error = `Not supported controller: ${controllerType}`;
                        log.error(error);
                        callback(new Error(error));
                        return;
                    }

                    const engine = this;
                    controller = new Controller(engine, connectionType, connectionOptions);
                }

                controller.addSocket(socket);

                if (controller.isOpen) {
                    // Join the room
                    socket.join(ident);

                    // Call the callback with connection state
                    const connectionState = _cloneDeep(controller.connectionState);
                    callback(null, connectionState);
                    return;
                }

                controller.open(err => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    // System Trigger: Open connection
                    this.event.trigger('connection:open');

                    if (controllers[ident]) {
                        log.error(`The connection was not properly closed: ident=${JSON.stringify(ident)}`);
                        delete controllers[ident];
                    }
                    controllers[ident] = controller;

                    // Join the room
                    socket.join(ident);

                    // Call the callback with connection state
                    const connectionState = _cloneDeep(controller.connectionState);
                    callback(null, connectionState);
                });
            });

            socket.on('close', (ident, callback = _noop) => {
                if (typeof callback !== 'function') {
                    callback = _noop;
                }

                log.debug(`socket.close(${JSON.stringify(ident)}): id=${socket.id}`);

                const controller = controllers[ident];
                if (!controller) {
                    const error = `The connection is not accessible: ident=${JSON.stringify(ident)}`;
                    log.error(error);
                    callback(new Error(error));
                    return;
                }

                // System Trigger: Close connection
                this.event.trigger('connection:close');

                // Leave the room
                socket.leave(ident);

                controller.close(() => {
                    // Remove controller from store
                    delete controllers[ident];
                    controllers[ident] = undefined;

                    // Call the callback with connection state
                    const connectionState = _cloneDeep(controller.connectionState);
                    callback(null, connectionState);

                    // Destroy controller
                    controller.destroy();
                });
            });

            socket.on('command', (ident, cmd, ...args) => {
                log.debug(`socket.command(${JSON.stringify(ident)}, ${JSON.stringify(cmd)}): id=${socket.id}`);

                const controller = controllers[ident];
                if (!controller || controller.isClose) {
                    log.error(`The connection is not accessible: ident=${JSON.stringify(ident)}`);
                    return;
                }

                controller.command.apply(controller, [cmd].concat(args));
            });

            socket.on('write', (ident, data, context = {}) => {
                log.debug(`socket.write(${JSON.stringify(ident)}, ${JSON.stringify(data)}, ${JSON.stringify(context)}): id=${socket.id}`);

                const controller = controllers[ident];
                if (!controller || controller.isClose) {
                    log.error(`The connection is not accessible: ident=${JSON.stringify(ident)}`);
                    return;
                }

                controller.write(data, context);
            });

            socket.on('writeln', (ident, data, context = {}) => {
                log.debug(`socket.writeln(${JSON.stringify(ident)}, ${JSON.stringify(data)}, ${JSON.stringify(context)}): id=${socket.id}`);

                const controller = controllers[ident];
                if (!controller || controller.isClose) {
                    log.error(`The connection is not accessible: ident=${JSON.stringify(ident)}`);
                    return;
                }

                controller.writeln(data, context);
            });
        });
    }

    stop() {
        if (this.io) {
            this.io.close();
            this.io = null;
        }
        this.sockets = [];
        this.server = null;

        userStore.removeListener('change', this.listener.configChange);

        shellCommand.removeListener('start', this.listener.taskStart);
        shellCommand.removeListener('finish', this.listener.taskFinish);
        shellCommand.removeListener('error', this.listener.taskError);
    }
}

const serviceEngine = new ServiceEngine();

export default serviceEngine;
