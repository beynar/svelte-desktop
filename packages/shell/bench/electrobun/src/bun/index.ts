import { BrowserWindow } from "electrobun/main";

new BrowserWindow({
	title: "Hello",
	url: "views://mainview/index.html",
	frame: { width: 800, height: 600, x: 200, y: 200 },
});
