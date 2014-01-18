/*
Copyright 2014 The Camlistore Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

goog.provide('cam.IndexPageReact');

goog.require('goog.string');
goog.require('goog.Uri');

goog.require('cam.BlobItemContainerReact');
goog.require('cam.DetailView');
goog.require('cam.Navigator');
goog.require('cam.NavReact');
goog.require('cam.reactUtil');
goog.require('cam.SearchSession');
goog.require('cam.ServerConnection');

cam.IndexPageReact = React.createClass({
	displayName: 'IndexPageReact',

	THUMBNAIL_SIZES_: [75, 100, 150, 200, 250, 300],

	SEARCH_PREFIX_: {
		RAW: 'raw'
	},

	propTypes: {
		availWidth: React.PropTypes.number.isRequired,
		availHeight: React.PropTypes.number.isRequired,
		config: React.PropTypes.object.isRequired,
		eventTarget: cam.reactUtil.quacksLike({addEventListener:React.PropTypes.func.isRequired}).isRequired,
		history: cam.reactUtil.quacksLike({pushState:React.PropTypes.func.isRequired}).isRequired,
		location: cam.reactUtil.quacksLike({href:React.PropTypes.string.isRequired, reload:React.PropTypes.func.isRequired}).isRequired,
		serverConnection: React.PropTypes.instanceOf(cam.ServerConnection).isRequired,
		timer: cam.NavReact.originalSpec.propTypes.timer,
	},

	componentWillMount: function() {
		var newURL = new goog.Uri(this.props.location.href);
		this.baseURL_ = newURL.resolve(new goog.Uri(CAMLISTORE_CONFIG.uiRoot));
		this.baseURL_.setParameterValue('react', '1');

		this.navigator_ = new cam.Navigator(this.props.eventTarget, this.props.location, this.props.history, true);
		this.navigator_.onNavigate = this.handleNavigate_;

		this.searchSession_ = null;
		this.currentSet_ = null;
		this.inSearchMode_ = false;
		this.inDetailMode_ = false;

		this.handleNavigate_(newURL);
	},

	getInitialState: function() {
		return {
			currentURL: null,
			isNavOpen: false,
			selection: {},
			thumbnailSizeIndex: 3,
		};
	},

	componentDidMount: function() {
		this.props.eventTarget.addEventListener('keypress', this.handleKeyPress_);
	},

	render: function() {
		return React.DOM.div({}, [
			this.getNav_(),
			this.getBlobItemContainer_(),
			this.getDetailView_(),
		]);
	},

	handleNavigate_: function(newURL) {
		if (this.state.currentURL) {
			if (this.state.currentURL.getPath() != newURL.getPath()) {
				return false;
			}
		}

		this.updateSearchSession_(newURL);

		// This is super finicky. We should improve the URL scheme and give things that are different different paths.
		var query = newURL.getQueryData();
		this.setState({currentURL: newURL});

		return true;
	},

	updateSearchSession_: function(newURL) {
		var query = newURL.getParameterValue('q');
		if (!query) {
			query = ' ';
		}

		// TODO(aa): Remove this when the server can do something like the 'raw' operator.
		if (goog.string.startsWith(query, this.SEARCH_PREFIX_.RAW + ':')) {
			query = JSON.parse(query.substring(this.SEARCH_PREFIX_.RAW.length + 1));
		}

		if (this.searchSession_ && JSON.stringify(this.searchSession_.getQuery()) == JSON.stringify(query)) {
			return;
		}

		if (this.searchSession_) {
			this.searchSession_.close();
		}

		this.searchSession_ = new cam.SearchSession(this.props.serverConnection, newURL.clone(), query);
	},

	getNav_: function() {
		if (!this.inSearchMode_()) {
			return null;
		}
		return cam.NavReact({key:'nav', ref:'nav', timer:this.props.timer, onOpen:this.handleNavOpen_, onClose:this.handleNavClose_}, [
			cam.NavReact.SearchItem({key:'search', ref:'search', iconSrc:'magnifying_glass.svg', onSearch:this.setSearch_}, 'Search'),
			cam.NavReact.Item({key:'newpermanode', iconSrc:'new_permanode.svg', onClick:this.handleNewPermanode_}, 'New permanode'),
			cam.NavReact.Item({key:'roots', iconSrc:'icon_27307.svg', onClick:this.handleShowSearchRoots_}, 'Search roots'),
			this.getSelectAsCurrentSetItem_(),
			this.getAddToCurrentSetItem_(),
			this.getCreateSetWithSelectionItem_(),
			this.getClearSelectionItem_(),
			cam.NavReact.Item({key:'up', iconSrc:'up.svg', onClick:this.handleEmbiggen_}, 'Moar bigger'),
			cam.NavReact.Item({key:'down', iconSrc:'down.svg', onClick:this.handleEnsmallen_}, 'Less bigger'),
			cam.NavReact.LinkItem({key:'logo', iconSrc:'/favicon.ico', href:this.baseURL_.toString(), extraClassName:'cam-logo'}, 'Camlistore'),
		]);
	},

	handleNavOpen_: function() {
		this.setState({isNavOpen:true});
	},

	handleNavClose_: function() {
		this.refs.search.clear();
		this.refs.search.blur();
		this.setState({isNavOpen:false});
	},

	handleNewPermanode_: function() {
		// TODO(aa): Here and below, we need SearchSession#reloadIfNecessary, which would refresh the data if socket not working.
		this.props.serverConnection.createPermanode(function(p) {
			this.navigator_.navigate(this.getDetailURL_(false, p));
		}.bind(this));
	},

	handleShowSearchRoots_: function() {
		this.setSearch_(this.SEARCH_PREFIX_.RAW + ':' + JSON.stringify({
			permanode: {
				attr: 'camliRoot',
				numValue: {
					min: 1
				}
			}
		}));
	},

	handleSelectAsCurrentSet_: function() {
		this.currentSet_ = goog.object.getAnyKey(this.state.selection);
		this.setState({selection:{}});
	},

	handleAddToSet_: function() {
		this.addMembersToSet_(this.currentSet_, goog.object.getKeys(this.state.selection));
	},

	handleCreateSetWithSelection_: function() {
		var selection = goog.object.getKeys(this.state.selection);
		this.props.serverConnection.createPermanode(function(permanode) {
			this.props.serverConnection.newSetAttributeClaim(permanode, 'title', 'New set', function() {
				this.addMembersToSet_(permanode, selection);
			}.bind(this));
		}.bind(this));
	},

	addMembersToSet_: function(permanode, blobrefs) {
		var numComplete = 0;
		var callback = function() {
			if (++numComplete == blobrefs.length) {
				this.setState({selection:{}});
			}
		}.bind(this);

		blobrefs.forEach(function(br) {
			this.props.serverConnection.newAddAttributeClaim(permanode, 'camliMember', br, callback);
		}.bind(this));
	},

	handleClearSelection_: function() {
		this.setState({selection:{}});
	},

	handleEmbiggen_: function() {
		var newSizeIndex = this.state.thumbnailSizeIndex + 1;
		if (newSizeIndex < this.THUMBNAIL_SIZES_.length) {
			this.setState({thumbnailSizeIndex:newSizeIndex});
		}
	},

	handleEnsmallen_: function() {
		var newSizeIndex = this.state.thumbnailSizeIndex - 1;
		if (newSizeIndex >= 0) {
			this.setState({thumbnailSizeIndex:newSizeIndex});
		}
	},

	handleKeyPress_: function(e) {
		if (String.fromCharCode(e.charCode) == '/') {
			this.refs.nav.open();
			this.refs.search.focus();
			e.preventDefault();
		}
	},

	handleDetailURL_: function(item) {
		return this.getDetailURL_(Boolean(item.im), item.blobref);
	},

	getDetailURL_: function(newUI, blobref) {
		var detailURL = this.state.currentURL.clone();
		detailURL.setParameterValue('p', blobref);
		if (newUI) {
			detailURL.setParameterValue('newui', '1');
		}
		return detailURL;
	},

	setSearch_: function(query) {
		var searchURL = this.baseURL_.clone();
		searchURL.setParameterValue('q', query);
		this.navigator_.navigate(searchURL);
	},

	getSelectAsCurrentSetItem_: function() {
		if (goog.object.getCount(this.state.selection) != 1) {
			return null;
		}

		var blobref = goog.object.getAnyKey(this.state.selection);
		var data = new cam.BlobItemReactData(blobref, this.searchSession_.getCurrentResults().description.meta);
		if (!data.isDynamicCollection) {
			return null;
		}

		return cam.NavReact.Item({key:'selectascurrent', iconSrc:'target.svg', onClick:this.handleSelectAsCurrentSet_}, 'Select as current set');
	},

	getAddToCurrentSetItem_: function() {
		if (!this.currentSet_ || !goog.object.getAnyKey(this.state.selection)) {
			return null;
		}
		return cam.NavReact.Item({key:'addtoset', iconSrc:'icon_16716.svg', onClick:this.handleAddToSet_}, 'Add to current set');
	},

	getCreateSetWithSelectionItem_: function() {
		var numItems = goog.object.getCount(this.state.selection);
		if (numItems == 0) {
			return null;
		}
		var label = numItems == 1 ? 'Create set with item' : goog.string.subs('Create set with %s items', numItems);
		return cam.NavReact.Item({key:'createsetwithselection', iconSrc:'circled_plus.svg', onClick:this.handleCreateSetWithSelection_}, label);
	},

	getClearSelectionItem_: function() {
		if (!goog.object.getAnyKey(this.state.selection)) {
			return null;
		}
		return cam.NavReact.Item({key:'clearselection', iconSrc:'clear.svg', onClick:this.handleClearSelection_}, 'Clear selection');
	},

	handleSelectionChange_: function(newSelection) {
		this.setState({selection:newSelection});
	},

	inSearchMode_: function() {
		// This is super finicky. We should improve the URL scheme and give things that are different different paths.
		var query = newURL.getQueryData();
		return (query.getCount() == 1 && query.containsKey('react')) || (query.getCount() == 2 && query.containsKey('react') && query.containsKey('q'));
	},

	inDetailMode_: function() {
		var query = newURL.getQueryData();
		return query.containsKey('p') && query.get('newui') == '1';
	},

	getBlobItemContainer_: function() {
		if (!this.inSearchMode_()) {
			return null;
		}
		return cam.BlobItemContainerReact({
			key: 'blobitemcontainer',
			ref: 'blobItemContainer',
			availWidth: this.props.availWidth,
			availHeight: this.props.availHeight,
			detailURL: this.handleDetailURL_,
			onSelectionChange: this.handleSelectionChange_,
			scrollEventTarget: this.props.eventTarget,
			searchSession: this.searchSession_,
			selection: this.state.selection,
			style: this.getBlobItemContainerStyle_(),
			thumbnailSize: this.THUMBNAIL_SIZES_[this.state.thumbnailSizeIndex],
			thumbnailVersion: Number(this.props.config.thumbVersion),
		});
	},

	getBlobItemContainerStyle_: function() {
		var style = {};

		// Need to be mounted to getDOMNode() below.
		if (!this.isMounted()) {
			return style;
		}

		var closedWidth = this.getDOMNode().offsetWidth - 36;
		var openWidth = closedWidth - (275 - 36);  // TODO(aa): Get this from DOM somehow?
		var openScale = openWidth / closedWidth;

		var currentHeight = goog.dom.getDocumentHeight();
		var currentScroll = goog.dom.getDocumentScroll().y;
		var potentialScroll = currentHeight - goog.dom.getViewportSize().height;
		var scrolledRatio = currentScroll / potentialScroll;
		var originY = currentHeight * currentScroll / potentialScroll;

		style[cam.reactUtil.getVendorProp('transformOrigin')] = goog.string.subs('right %spx 0', originY);

		// The 3d transform is important. See: https://code.google.com/p/camlistore/issues/detail?id=284.
		var scale = this.state.isNavOpen ? openScale : 1;
		style[cam.reactUtil.getVendorProp('transform')] = goog.string.subs('scale3d(%s, %s, 1)', scale, scale);

		return style;
	},

	getDetailView_: function() {
		if (!this.inDetailMode_()) {
			return null;
		}

		var searchURL = this.baseURL_.clone();
		if (this.state.currentURL.getQueryData().containsKey('q')) {
			searchURL.setParameterValue('q', this.state.currentURL.getParameterValue('q'));
		}

		var oldURL = this.baseURL_.clone();
		oldURL.setParameterValue('p', this.state.currentURL.getParameterValue('p'));

		return cam.DetailView({
			key: 'detailview',
			blobref: this.state.currentURL.getParameterValue('p'),
			searchSession: this.searchSession_,
			searchURL: searchURL,
			oldURL: oldURL,
			getDetailURL: this.getDetailURL_.bind(this, false),
			navigator: this.navigator_,
			keyEventTarget: this.props.eventTarget,
			width: this.props.availWidth,
			height: this.props.availHeight,
		});
	},
});
