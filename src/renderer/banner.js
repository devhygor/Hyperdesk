'use strict';
const peer = new URLSearchParams(location.search).get('peer');
if (peer) document.getElementById('txt').textContent = `${peer} está controlando este PC`;
document.getElementById('stop').onclick = () => window.hmd.send('hmd:disconnect-session');
document.getElementById('hide').onclick = () => window.hmd.send('hmd:banner-hide');
