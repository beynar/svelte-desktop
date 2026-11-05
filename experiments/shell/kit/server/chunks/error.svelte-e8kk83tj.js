// @bun
import {
  escape_html,
  getContext
} from "./index-g45m2085.js";
import"./index-p8d9cnqj.js";
import"./index-ygjk2325.js";

// .svelte-kit/output/server/entries/fallbacks/error.svelte.js
function context() {
  return getContext("__request__");
}
var page = {
  get data() {
    return context().page.data;
  },
  get error() {
    return context().page.error;
  },
  get form() {
    return context().page.form;
  },
  get params() {
    return context().page.params;
  },
  get route() {
    return context().page.route;
  },
  get shallow() {
    return context().page.shallow;
  },
  get state() {
    return context().page.state;
  },
  get status() {
    return context().page.status;
  },
  get url() {
    return context().page.url;
  }
};
function Error$1($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    $$renderer2.push(`<h1>${escape_html(page.status)}</h1> <p>${escape_html(page.error?.message)}</p>`);
  });
}
export {
  Error$1 as default
};

//# debugId=1CA684E81EDEC2EF64756E2164756E21
