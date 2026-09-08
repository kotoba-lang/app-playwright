(ns playwright.app-test
  (:require [cljs.test :refer [deftest is testing use-fixtures]]
            [re-frame.core :as rf]
            [re-frame.db :as rf-db]
            [playwright.app :as app]))

(use-fixtures :each
  {:before (fn [] (rf/clear-subscription-cache!) (reset! rf-db/app-db {}))})

(deftest initialize-db-sets-defaults
  (testing ":initialize-db populates the ported +page.svelte `app` object"
    (rf/dispatch-sync [:initialize-db])
    (is (= app/default-db @rf-db/app-db))
    (is (= "Playwright Pl4y1t8r" @(rf/subscribe [:title])))
    (is (= "etzhayyim-project-playwright" @(rf/subscribe [:project])))
    (is (= "etzhayyim-wasm-playwright-pl4y1t8r" @(rf/subscribe [:name])))
    (is (= "appview" @(rf/subscribe [:kind])))
    (is (= 2 @(rf/subscribe [:route-count])))
    (is (= ["pl4y1t8r.etzhayyim.com/*" "playwright.etzhayyim.com/*"]
           @(rf/subscribe [:routes])))
    (is (= 13 (count @(rf/subscribe [:vars]))))
    (is (true? @(rf/subscribe [:xrpc?])))
    (is (= "appview/etzhayyim-wasm-playwright-pl4y1t8r/cljs/src/playwright/app.cljs"
           @(rf/subscribe [:relative-path])))))

(deftest vars-sub-carries-every-original-binding-name
  (testing "no runtime var name was dropped or renamed during the port"
    (rf/dispatch-sync [:initialize-db])
    (is (= #{"AGENTGATEWAY_MCP_ROUTER_URL" "APP_CAPABILITIES" "APP_DEPLOY_AT"
             "APP_DESCRIPTION" "APP_DISPLAY_NAME" "APP_EMBED_URL"
             "APP_FRAMEWORK" "APP_NANOID" "APP_PERFORMER_TYPE" "APP_SOURCE"
             "APP_UI_TYPE" "APP_VERSION" "INTERFACES_REQUIRES"}
           (set @(rf/subscribe [:vars]))))))

(deftest routes-sub-reflects-db-not-a-fixed-value
  (testing ":routes subscription reads whatever is in the db"
    (reset! rf-db/app-db {:routes ["only-one.example/*"]})
    (is (= ["only-one.example/*"] @(rf/subscribe [:routes])))))

(deftest xrpc-sub-reflects-db-not-a-fixed-value
  (testing ":xrpc? subscription reads whatever is in the db"
    (reset! rf-db/app-db {:xrpc? false})
    (is (false? @(rf/subscribe [:xrpc?])))))

(deftest initialize-db-overwrites-prior-state
  (testing ":initialize-db resets to defaults even if the db already had other data"
    (reset! rf-db/app-db {:title "stale" :unrelated 42})
    (rf/dispatch-sync [:initialize-db])
    (is (= app/default-db @rf-db/app-db))))
