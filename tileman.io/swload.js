if ('serviceWorker' in navigator) {
	window.addEventListener('load', function () {
		navigator.serviceWorker.register('/service-worker.js');
	});

	navigator.serviceWorker.addEventListener('message', async (event) => {
		if (event.data.meta !== 'workbox-broadcast-update') return;
		const { cacheName, updatedURL } = event.data.payload;
		console.log("workbox-broadcast-update", event.data);
		if (updatedURL.indexOf("/style.css") !== -1) {
			const cache = await caches.open(cacheName);
			const updatedResponse = await cache.match(updatedURL);
			console.log(cacheName, updatedURL, updatedResponse);
			const updatedText = await updatedResponse.text();

			document.head.insertAdjacentHTML("beforeend", "<style>" + updatedText + "</style>");
			const oldStyle = document.querySelector('link[href*="/style.css"]');
			oldStyle.parentElement.removeChild(oldStyle);
		}
		else if (updatedURL) {
		}
	});
}
