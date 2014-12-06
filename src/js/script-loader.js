'use strict';

function Loader(config) {
    Loader.superclass.constructor.apply(this, arguments);

    this._config = config || global.__CONFIG__;
}

extend(Loader, global.EventEmitter, {
    define: function (name, dependencies, implementation, config) {
        var self = this;

        return new Promise(function (resolve, reject) {
            // Create new module by merging the provided config with the passed name,
            // dependencies and the implementation.
            var module = config || {};

            module.name = name;
            module.dependencies = dependencies;
            module.pendingImplementation = implementation;

            self._getConfigParser().resolveDependenciesPath(module);

            var dependeciesResolved = self._checkModuleDependencies(module);

            if (dependeciesResolved) {
                self._registerModule(module);

                resolve(module);
            } else {
                self._waitForImplementation(module)
                    .then(function(module) {
                        self._registerModule(module);
                    });
            }
        });
    },

    require: function () {
        var self = this;

        var failureCallback;
        var modules;
        var successCallback;

        var isArgsArray = Array.isArray ? Array.isArray(arguments[0]) : Object.prototype.toString.call(arguments[0]) === '[object Array]';

        if (isArgsArray) {
            modules = arguments[0];
            successCallback = typeof arguments[1] === 'function' ? arguments[1] : null;
            failureCallback = typeof arguments[2] === 'function' ? arguments[2] : null;

        } else {
            modules = [];

            for (var i = 0; i < arguments.length; ++i) {
                if (typeof arguments[i] === 'string') {
                    modules[i] = arguments[i];

                } else if (typeof arguments[i] === 'function') {
                    successCallback = arguments[i];
                    failureCallback = typeof arguments[++i] === 'function' ? arguments[i] : null;

                    break;
                } else {
                    break;
                }
            }
        }

        self._resolveDependencies(modules).then(function (dependencies) {
            return self._loadModules(dependencies);
        }).then(function (loadedModules) {
            var moduleImplementations = self._addModuleImplementations(modules);

            if (successCallback) {
                successCallback.apply(successCallback, moduleImplementations);
            }
        }, function (error) {
            if (failureCallback) {
                failureCallback.call(failureCallback, error);

            } else if (successCallback) {
                var moduleImplementations = self._addModuleImplementations(modules);

                successCallback.apply(successCallback, moduleImplementations);
            }
        });
    },

    _addModuleImplementations: function (requiredModules) {
        var moduleImplementations = [];

        var modules = this._getConfigParser().getModules();

        for (var i = 0; i < requiredModules.length; i++) {
            var requiredModule = modules[requiredModules[i]];

            moduleImplementations.push(requiredModule ? requiredModule.implementation : undefined);
        }

        return moduleImplementations;
    },

    _checkModuleDependencies: function (module) {
        var modules = this._getConfigParser().getModules();

        var found = true;

        var dependencies = module.dependencies;

        for (var i = 0; i < dependencies.length; i++) {
            var dependencyName = dependencies[i];

            if (dependencyName === 'exports') {
                continue;

            }

            var dependencyModule = modules[dependencyName];

            if (!dependencyModule) {
                throw 'Dependency ' + dependencies[i] + ' not registered as module.';
            }

            var dependencyModuleImpl = dependencyModule.implementation;

            if (!dependencyModuleImpl) {
                found = false;

                break;
            }
        }

        return found;
    },

    _getConfigParser: function () {
        /* istanbul ignore else */
        if (!this._configParser) {
            this._configParser = new global.ConfigParser(this._config);
        }

        return this._configParser;
    },

    _getDependencyBuilder: function () {
        if (!this._dependencyBuilder) {
            this._dependencyBuilder = new global.DependencyBuilder(this._getConfigParser());
        }

        return this._dependencyBuilder;
    },

    _getPathResolver: function() {
        if (!this._pathResolver) {
            this._pathResolver = new global.PathResolver();
        }

        return this._pathResolver;
    },

    _getURLBuilder: function () {
        if (!this._urlBuilder) {
            this._urlBuilder = new global.URLBuilder(this._getConfigParser());
        }

        return this._urlBuilder;
    },

    _filterModulesNoImpl: function(modules) {
        var missingModules = [];

        var registeredModules = this._getConfigParser().getModules();

        for (var i = 0; i < modules.length; i++) {
            var registeredModule = registeredModules[modules[i]];

            // Get all modules which don't have implementation, except 'exports' module
            if (registeredModule !== 'exports' &&
                (!registeredModule || !registeredModule.implementation)) {

                missingModules.push(modules[i]);
            }
        }

        return missingModules;
    },

    _filterNotLoadedModules: function (modules) {
        var missingModules = [];

        var registeredModules = this._getConfigParser().getModules();

        for (var i = 0; i < modules.length; i++) {
            var registeredModule = registeredModules[modules[i]];

            // Get all modules which don't have implementarion and they were not requested from the server.
            if (registeredModule !== 'exports' &&
                (!registeredModule || (!registeredModule.implementation && !registeredModule.load))) {

                missingModules.push(modules[i]);
            }
        }

        return missingModules;
    },

    _loadModules: function (modules) {
        var self = this;

        return new Promise(function (resolve, reject) {
            var missingModules = self._filterNotLoadedModules(modules);

            if (missingModules.length) {
                var urls = self._getURLBuilder().build(missingModules);

                var pendingScripts = [];

                for (var i = 0; i < urls.length; i++) {
                    pendingScripts.push(self._loadScript(urls[i]));
                }

                Promise.all(pendingScripts).then(function (loadedScripts) {
                    return self._waitForImplementations(modules);
                })
                .then(function(modules) {
                    resolve(modules);
                })
                .catch (function (error) {
                    reject(error);
                });
            } else {
                self._waitForImplementations(modules)
                    .then(function(modules) {
                        resolve(modules);
                    })
                    .catch (function (error) {
                        reject(error);
                    });
            }
        });
    },

    _registerModule: function (module) {
        var dependencyImplementations = [];

        var modules = this._getConfigParser().getModules();

        // Leave exports implementation undefined by default
        var exportsImpl;

        for (var i = 0; i < module.dependencies.length; i++) {
            var dependency = module.dependencies[i];

            var impl;

            // If the current dependency of this module is 'exports',
            // create an empty object and pass it as implementation of
            // 'exports' module
            if (dependency === 'exports') {
                exportsImpl = {};

                dependencyImplementations.push(exportsImpl);
            }
            else {
                // otherwise set as value the implementation of the
                // registered module
                var dependencyModule = modules[dependency];

                impl = dependencyModule.implementation;

                dependencyImplementations.push(impl);
            }
        }

        var result = module.pendingImplementation.apply(module.pendingImplementation, dependencyImplementations);

        // Store as implementation either the returned value from function invocation
        // or the implementation of the 'exports' obejct.
        // The final implementation of this module may be undefined if there is no
        // returned value, or the object does not have 'exports' dependency
        module.implementation = result || exportsImpl;

        console.log('Register module: ' + module.name);

        this._getConfigParser().addModule(module);

        this.emit('moduleRegister', module);
    },

    _resolveDependencies: function (modules) {
        var self = this;

        return new Promise(function (resolve, reject) {
            try {
                var registeredModules = self._getConfigParser().getModules();
                var finalModules = [];

                // Ignore wrongly specified (misspelled) modules
                for (var i = 0; i < modules.length; i++) {
                    if (registeredModules[modules[i]]) {
                        finalModules.push(modules[i]);
                    }
                }

                var dependencies = self._getDependencyBuilder().resolveDependencies(finalModules);

                resolve(dependencies);
            } catch (error) {
                reject(error);
            }
        });
    },

    _loadScript: function (url) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');

            script.src = url;

            console.log(url);

            script.onload = script.onreadystatechange = function () {
                if (!this.readyState || this.readyState === 'complete' || this.readyState === 'load') {

                    script.onload = script.onreadystatechange = null;

                    resolve(script);
                }
            };

            script.onerror = function () {
                document.body.removeChild(script);

                reject(script);
            };

            document.body.appendChild(script);
        });
    },

    _waitForImplementation: function(module) {
        var self = this;

        return new Promise(function(resolve, reject) {
            if (module.implementation) {
                resolve(module);

            } else {
                var onModuleRegister = function (registeredModule) {
                    var dependenciesResolved = self._checkModuleDependencies(module);

                    if (dependenciesResolved) {
                        self.off('moduleRegister', onModuleRegister);

                        resolve(module);
                    }
                };

                self.on('moduleRegister', onModuleRegister);
            }
        });
    },

    _waitForImplementations: function(modules) {
        var self = this;

        return new Promise(function(resolve, reject) {
            var missingModules = self._filterModulesNoImpl(modules);

            if (!missingModules.length) {
                resolve(modules);
            } else {
                var modulesPromises = [];

                var registeredModules = self._getConfigParser().getModules();

                for (var i = 0; i < modules.length; i++) {
                    modulesPromises.push(self._waitForImplementation(registeredModules[modules[i]]));
                }

                Promise.all(modulesPromises)
                    .then(function(modules) {
                        resolve(modules);
                    });
            }
        });
    }
});

// Utilities methods
function extend(r, s, px) {
    if (!s || !r) {
        throw ('extend failed, verify dependencies');
    }

    var sp = s.prototype,
        rp = Object.create(sp);
    r.prototype = rp;

    rp.constructor = r;
    r.superclass = sp;

    // assign constructor property
    if (s != Object && sp.constructor == Object.prototype.constructor) {
        sp.constructor = s;
    }

    // add prototype overrides
    if (px) {
        mix(rp, px);
    }

    return r;
}

function mix(destination, source) {
    var hasOwnProperty = Object.prototype.hasOwnProperty;

    for (var k in source) {
        /* istanbul ignore else */
        if (hasOwnProperty.call(source, k)) {
            destination[k] = source[k];
        }
    }

    return destination;
}