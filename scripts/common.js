window.browser = (_ => window.browser || window.chrome)()
const isFirefox = (window.browser && browser.runtime) || navigator.userAgent.indexOf('Firefox') !== -1;
var EXT_OPTIONS = {history: 14, morning: 9, evening: 18, badge: 'today', contextMenu: ['today-evening', 'tom-morning', 'monday']}
/*	ASYNCHRONOUS FUNCTIONS	*/
/*	GET 	*/
async function getSnoozedTabs() {
	var p = await new Promise(r => chrome.storage.local.get('snoozed', r));
	return p.snoozed
}
async function getOptions() {
	var p = await new Promise(r => chrome.storage.local.get('snoozedOptions', r));
	return p.snoozedOptions
}
async function getTabsInWindow(active) {
	var p = new Promise(r => chrome.tabs.query({active: active}, r));
	if (!active) return p;
	var tabs = await p;
	return tabs[0];
}
async function getTabId(url) {
	var tabsInWindow = await getTabsInWindow();
	var foundTab  = tabsInWindow.find(t => t.url === url);
	return foundTab ? parseInt(foundTab.id) : false; 
}
/*	SAVE 	*/
async function saveOptions(o) {
	var p = new Promise(r => chrome.storage.local.set({'snoozedOptions': o}, r));
	await p;
	chrome.runtime.sendMessage({updateOptions: true});
}
async function saveTab(t) {
	var tabs = await getSnoozedTabs();
	tabs.push(t);
	await saveTabs(tabs);
}
async function saveTabs(tabs) {
	updateBadge(sleeping(tabs));
	return new Promise(r => chrome.storage.local.set({'snoozed': tabs}, r));
}
/*	CREATE 	*/
function createAlarm(name, time) {
	console.log('Alarm created: '+ new Date().toLocaleString('en-IN') + ' | Waking up at: ' + new Date(time).toLocaleString('en-IN'));
	chrome.alarms.create(name, {when: time});
}
function createNotification(id, title, imgUrl, msg, clickUrl) {
	chrome.notifications.create(id, {type: 'basic', iconUrl: chrome.extension.getURL(imgUrl), title: title, message: msg});
	if (clickUrl) chrome.notifications.onClicked.addListener(_ => openExtensionTab(clickUrl));
}
async function createWindow(tabId) {
	return new Promise(r => chrome.windows.create({url: `rise_and_shine.html#${tabId}`, focused: true}, r));
}

/*	CONFIGURE	*/
async function configureOptions() {
	var storageOptions = await getOptions();
	EXT_OPTIONS = Object.assign(EXT_OPTIONS, storageOptions)
	return;
}

/*	OPEN 	*/

// open tab for an extension page
async function openExtensionTab(url) {
	var tabs = await getTabsInWindow();
	var extTabs = tabs.filter(t => isDefault(t));

	if (extTabs.length === 1){chrome.tabs.update(extTabs[0].id, {url: url, active: true})}
	else if (extTabs.length > 1) {
		var activeTab = extTabs.some(et => et.active) ? extTabs.find(et => et.active) : extTabs.reduce((t1, t2) => t1.index > t2.index ? t1 : t2);
		chrome.tabs.update(activeTab.id, {url: url, active: true});
		chrome.tabs.remove(extTabs.filter(et => et !== activeTab).map(t => t.id))		
	} else {
		var activeTab = tabs.find(t => t.active);
		if (activeTab && activeTab.title === 'New Tab') {chrome.tabs.update(activeTab.id, {url: url})}
		else {chrome.tabs.create({url: url})}
	}
}

async function openTab(tab, automatic = false) {
	await new Promise(r => chrome.tabs.create({url: tab.url, active: false, pinned: tab.pinned, windowId: tab.forceWindow}, r));
	if (!automatic) return;
	var msg = `${tab.title} -- snoozed ${dayjs(tab.timeCreated).fromNow()}`;
	createNotification(tab.id, 'A tab woke up!', 'icons/main-icon.png', msg, 'dashboard.html');
}

async function openWindow(t, automatic = false) {
	var targetWindow = await createWindow(t.id);

	// send message to map chrome tabs to tab-list in rise_and_shine.html
	var loadingCount = 0;
	chrome.tabs.onUpdated.addListener(async function cleanTabsAfterLoad(id, state, title) {
		if (loadingCount > t.tabs.length) {
			chrome.runtime.sendMessage({startMapping: true});
			chrome.tabs.onUpdated.removeListener(cleanTabsAfterLoad)
		}
		if (state.status === 'loading' && state.url) loadingCount ++;
	});

	for (var s of t.tabs) await openTab(Object.assign(s, {forceWindow: targetWindow.id}));
	chrome.windows.update(targetWindow.id, {focused: true});
	
	if (!automatic) return;
	var msg = `This window was put to sleep ${dayjs(t.timeCreated).fromNow()}`;
	createNotification(t.id, 'A window woke up!', 'icons/main-icon.png', msg, 'dashboard.html');
	return;
}

async function snoozeTab(snoozeTime, overrideTab) {
	var activeTab = overrideTab || await getTabsInWindow(true);
	if (!activeTab || !activeTab.url) return {};
	var sleepyTab = {
		id: Math.random().toString(36).slice(-6),
		title: activeTab.title ?? getBetterUrl(activeTab.url),
		url: activeTab.url,
		favicon: activeTab.favIconUrl ?? '',
		...activeTab.pinned ? {pinned: true} : {},
		wakeUpTime: dayjs(snoozeTime).valueOf(),
		timeCreated: dayjs().valueOf(),
	}
	await saveTab(sleepyTab);
	var tabId = activeTab.id || await getTabId(activeTab.url);
	return {tabId: tabId}
}

async function snoozeWindow(snoozeTime) {
	var tabsInWindow = await getTabsInWindow();
	var validTabs = tabsInWindow.filter(t => !isDefault(t));
	if (validTabs.length === 0) return {};
	if (validTabs.length === 1) {
		await snoozeTab(snoozeTime, validTabs[0])
		return {windowId: tabsInWindow.find(w => w.active).windowId};
	}
	var sleepyGroup = {
		id: Math.random().toString(36).slice(-6),
		title: `${getTabCountLabel(validTabs)} from ${getSiteCountLabel(validTabs)}`,
		wakeUpTime: dayjs(snoozeTime).valueOf(),
		timeCreated: dayjs().valueOf(),
		tabs: validTabs.map(t => {return {title: t.title, url: t.url, favicon: t.favIconUrl ?? '', ...t.pinned ? {pinned: true} : {},}})
	}
	await saveTab(sleepyGroup);
	return {windowId: tabsInWindow.find(w => w.active).windowId};
}
/* END ASYNC FUNCTIONS */

var getChoices = _ => {
	var NOW = dayjs();
	return {
		'today-morning': {
			label: 'This Morning',
			color: '#F7D05C',
			time: NOW.startOf('d').add(EXT_OPTIONS.morning, 'h'),
			timeString: 'Today',
			disabled: NOW.startOf('d').add(EXT_OPTIONS.morning, 'h').valueOf() < dayjs()
		},
		'today-evening': {
			label: 'This Evening',
			color: '#E1AD7A',
			time: NOW.startOf('d').add(EXT_OPTIONS.evening, 'h'),
			timeString: 'Today',
			disabled: NOW.startOf('d').add(EXT_OPTIONS.evening, 'h').valueOf() < dayjs()
		},
		'tom-morning': {
			label: 'Tomorrow Morning',
			color: '#00b77d',
			time: NOW.startOf('d').add(1,'d').add(EXT_OPTIONS.morning, 'h'),
			timeString: NOW.add(1,'d').format('ddd D')
		},
		'tom-evening': {
			label: 'Tomorrow Evening',
			color: '#87CCE2',
			time: NOW.startOf('d').add(1,'d').add(EXT_OPTIONS.evening, 'h'),
			timeString: NOW.add(1,'d').format('ddd D')
		},
		'weekend': {
			label: 'Weekend',
			color: '#F08974',
			time: NOW.startOf('d').weekday(6).add(EXT_OPTIONS.morning, 'h'),
			timeString: NOW.weekday(6).format('ddd, D MMM'),
			// disabled: NOW.weekday(6).dayOfYear() === NOW.add(1, 'd').dayOfYear() || NOW.weekday(6).dayOfYear() === NOW.dayOfYear()
		},
		'monday': {
			label: 'Next Monday',
			color: '#488863',
			time: NOW.startOf('d').weekday(8).add(EXT_OPTIONS.morning, 'h'),
			timeString: NOW.weekday(8).format('ddd, D MMM'),
			isDark: true,
		},
		'week': {
			label: 'Next Week',
			color: '#847AD0',
			time: NOW.add(1, 'week'),
			timeString: NOW.add(1, 'week').format('D MMM'),
			isDark: true,
		},
		'month': {
			label: 'Next Month',
			color: '#F0C26C',
			time: NOW.add(1, 'M'),
			timeString: NOW.add(1, 'M').format('D MMM')
		}
	}
}

var getFaviconUrl = url => `https://www.google.com/s2/favicons?sz=32&domain=${getHostname(url)}`

var getHostname = url => Object.assign(document.createElement('a'), {href: url}).hostname;

var getBetterUrl = url => {
	var a = Object.assign(document.createElement('a'), {href: url});
	return a.hostname + a.pathname;
}

var getTabCountLabel = tabs => `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`

var getSiteCountLabel = tabs => {
	var count = tabs.map(t => getHostname(t.url)).filter((v,i,s) => s.indexOf(v) === i).length;
	return count > 1 ? `${count} different websites` : `${count} website`;
}

var sleeping = tabs => tabs.filter(t => !t.opened);

var today = tabs => tabs.filter(t => t.wakeUpTime && dayjs(t.wakeUpTime).dayOfYear() === dayjs().dayOfYear())

var isDefault = tabs => tabs.title && ['dashboard | snoozz', 'settings | snoozz', 'rise and shine | snoozz', 'New Tab'].includes(tabs.title);

var wrapInDiv = (attr, ...nodes) => {
	var div = Object.assign(document.createElement('div'), typeof attr === 'string' ? {className: attr} : attr);
	div.append(...nodes)
	return div;
}

var updateBadge = tabs => {
	var num = 0;
	if (tabs.length > 0 && EXT_OPTIONS.badge && EXT_OPTIONS.badge === 'all') num = tabs.length;
	if (tabs.length > 0 && EXT_OPTIONS.badge && EXT_OPTIONS.badge === 'today') num = today(tabs).length;
	chrome.browserAction.setBadgeText({text: num > 0 ? num.toString() : ''});
	chrome.browserAction.setBadgeBackgroundColor({color: '#CF5A77'});
}

var showIconOnScroll = _ => {
	var header = document.querySelector('body > div.flex.center')
	var logo = document.querySelector('body > div.scroll-logo');
	if (!header || !logo) return;

	logo.addEventListener('click', _ => window.scrollTo({top: 0,behavior: 'smooth'}));
	document.addEventListener('scroll', _ => {
		if (logo.classList.contains('hidden') && window.pageYOffset > (header.offsetHeight + header.offsetTop)) logo.classList.remove('hidden')
		if (!logo.classList.contains('hidden') && window.pageYOffset <= (header.offsetHeight + header.offsetTop)) logo.classList.add('hidden')
	})
}