define([
    "dojo/_base/declare",
    "dojo/_base/connect",
    "dojo/_base/array",
    "dojo/_base/lang",
    "dojo/Stateful",
    "esri/InfoTemplate",
    "esri/symbols/PictureMarkerSymbol",
    "esri/layers/FeatureLayer",
    "esri/geometry/Extent",
    "esri/geometry/Point",
    "esri/graphic",
    "esri/request",
    "esri/geometry/webMercatorUtils",
    "esri/geometry/mathUtils"
],
function(declare, connect, arr, lang, Stateful, InfoTemplate, PictureMarkerSymbol, FeatureLayer, Extent, Point, Graphic, esriRequest, webMercatorUtils, mathUtils) {
    var Widget = declare("modules.Eventbrite", [Stateful], {
        constructor: function(options) {
            var _self = this;
            _self.options = {
                app_key: '',
                id: 'eventbrite',
                keywords: '',
                autopage: true,
                maxpage: 5,
                symbol: PictureMarkerSymbol('images/eb_icon.png', 24, 24)
            };
            declare.safeMixin(_self.options, options);
            if (_self.options.map === null) {
                throw 'Reference to esri.Map object required';
            }
            _self.featureCollection = {
                layerDefinition: {
                    "geometryType": "esriGeometryPoint",
                    "fields": [{
                        "name": "OBJECTID",
                        "type": "esriFieldTypeOID"
                    }]
                },
                featureSet: {
                    "features": [],
                    "geometryType": "esriGeometryPoint"
                }
            };
            _self.infoTemplate = new InfoTemplate(_self.infoWindowTitle, _self.infoWindowContent);
            _self.featureLayer = new FeatureLayer(_self.featureCollection, {
                id: _self.options.id,
                outFields: ["*"],
                infoTemplate: _self.infoTemplate,
                visible: true
            });
            connect.connect(_self.options.map, "onExtentChange", function() {
                _self.update();
            });
            _self.options.map.addLayer(_self.featureLayer);
            _self._stats = {
                geoPoints: 0,
                geoNames: 0,
                noGeo: 0
            };
            _self.set('stats', _self._stats);
            _self._dataPoints = [];
            _self.set('dataPoints', []);
            _self._deferreds = [];
            _self._geocoded_ids = {};
            _self.set('loaded', true);
        },
        update: function(options) {
            declare.safeMixin(this.options, options);
            this.constructQuery();
        },
        infoWindowTitle: function(graphic) {
            var html = '';
            var event = graphic.attributes.event;
            if (event) {
                html += event.title;
            }
            return html;
        },
        infoWindowContent: function(graphic) {
            var html = '';
            var event = graphic.attributes.event;
            if (event) {
                html += '<div class="ebInfoWindow">'
                html += '<div style="padding:10px; background-color:#' + event.box_background_color + '; border: 1px solid #' + event.box_border_color + '; color:' + event.box_text_color + ';">'
                if (event.logo) {
                    html += '<a href="' + event.url + '" target="_blank"><img src="' + event.logo + '" /></a>';
                }
                html += '<a href="' + event.url + '" target="_blank">More info</a>';
                html += event.description;
                html += '</div>'
                html += '</div>'
            }
            return html;
        },
        clear: function() {
            // cancel any outstanding requests
            this.query = null;
            arr.forEach(this._deferreds, function(def) {
                def.cancel();
            });
            if (this._deferreds) {
                this._deferreds.length = 0;
            }
            // remove existing Photos
            if (this.options.map.infoWindow.isShowing) {
                this.options.map.infoWindow.hide();
            }
            if (this.featureLayer.graphics.length > 0) {
                this.featureLayer.applyEdits(null, null, this.featureLayer.graphics);
            }
            // clear data
            this._stats = {
                geoPoints: 0,
                noGeo: 0,
                geoNames: 0
            };
            this.set('stats', this._stats);
            this._dataPoints = [];
            this.set('dataPoints', []);
            this._geocoded_ids = {};
            this.onClear();
        },
        show: function() {
            this.featureLayer.setVisibility(true);
        },
        hide: function() {
            this.featureLayer.setVisibility(false);
        },
        setVisibility: function(val) {
            if (val) {
                this.show();
            } else {
                this.hide();
            }
        },
        getRadius: function() {
            var map = this.options.map;
            var extent = map.extent;
            this.maxRadius = 600;
            var radius = Math.min(this.maxRadius, Math.ceil(mathUtils.getLength(new Point(extent.xmin, extent.ymin, map.spatialReference), new Point(extent.xmax, extent.ymin, map.spatialReference)) * 3.281 / 5280 / 2));
            radius = Math.round(radius, 0);
            var geoPoint = webMercatorUtils.webMercatorToGeographic(extent.getCenter());
            return {
                radius: radius,
                center: geoPoint,
                units: "M"
            };
        },
        constructQuery: function() {
            var radius = this.getRadius();
            this.baseurl = location.protocol + "//www.eventbrite.com/json/event_search";
            this.query = {
                app_key: this.options.app_key,
                keywords: this.options.keywords,
                within: radius.radius,
                within_unit: radius.units,
                latitude: radius.center.y,
                longitude: radius.center.x,
                page: 1,
                max: 100
            };
            this.pageCount = 1;
            this.sendRequest();
        },
        sendRequest: function() {
            // get the results for each page
            var deferred = esriRequest({
                url: this.baseurl,
                content: this.query,
                handleAs: "json",
                timeout: 10000,
                load: lang.hitch(this, function(data) {
                    if (data.events && data.events.length) {
                        this.mapResults(data);
                        if ((this.options.autopage) && (this.options.maxpage > this.pageCount) && (data.events[0].summary.total_items !== data.events[0].summary.num_showing) && (this.query)) {
                            this.query.page++;
                            this.pageCount++;
                            this.sendRequest();
                        } else {
                            this.onUpdateEnd();
                        }
                    } else {
                        // No results found, try another search term
                        this.onUpdateEnd();
                    }
                }),
                error: lang.hitch(this, function(e) {
                    if (deferred.canceled) {
                        console.log('Search Cancelled');
                    } else {
                        console.log('Search error' + ": " + e.message.toString());
                    }
                    this.onError(e);
                })
            });
            this._deferreds.push(deferred);
        },
        unbindDef: function(dfd) {
            // if deferred has already finished, remove from _deferreds array
            var index = arr.indexOf(this._deferreds, dfd);
            if (index === -1) {
                return; // did not find
            }
            this._deferreds.splice(index, 1);
            if (!this._deferreds.length) {
                return 2; // indicates we received results from all expected _deferreds
            }
            return 1; // found and removed
        },
        mapResults: function(j) {
            var _self = this;
            if (j.error) {
                console.log("mapResults error: " + j.error);
                this.onError(j.error);
                return;
            }
            var b = [];
            var k = j.events;
            arr.forEach(k, lang.hitch(this, function(result) {
                if (result.event) {
                    result.smType = this.options.id;
                    // eliminate geo photos which we already have on the map
                    if (this._geocoded_ids[result.event.id]) {
                        return;
                    }
                    this._geocoded_ids[result.event.id] = true;
                    var geoPoint = null;
                    if (result.event.venue.latitude) {
                        var g = [result.event.venue.latitude, result.event.venue.longitude];
                        geoPoint = Point(parseFloat(g[1]), parseFloat(g[0]));
                    }
                    if (geoPoint) {
                        if (isNaN(geoPoint.x) || isNaN(geoPoint.y)) {
                            this._stats.noGeo++;
                        } else {
                            // convert the Point to WebMercator projection
                            var a = new webMercatorUtils.geographicToWebMercator(geoPoint);
                            var graphic = new Graphic(a, _self.options.symbol, result, _self.infoTemplate);
                            b.push(graphic);
                            this._dataPoints.push({
                                geometry: a,
                                symbol: _self.options.symbol,
                                attributes: result
                            });
                            this._stats.geoPoints++;
                        }
                    } else {
                        this._stats.noGeo++;
                    }
                }
            }));
            _self.set('stats', _self._stats);
            _self.set('dataPoints', _self._dataPoints);
            this.featureLayer.applyEdits(b, null, null);
            this.onUpdate();
        },
        onClear: function() {},
        onError: function(info) {
            this.onUpdateEnd();
        },
        onUpdate: function() {},
        onUpdateEnd: function() {}
    });
    return Widget;
});