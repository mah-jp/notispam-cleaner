# NotiSpam Cleaner — Notification Spam Blocker

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v1.0.0-blue.svg)](https://chromewebstore.google.com/detail/notispam-cleaner-notifica/dahnhdiabhegihofjijbchegffnkiaap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**NotiSpam Cleaner** is a privacy-first, open-source Google Chrome extension designed to scan, manage, and block website notification permissions to protect against notification spam. By revoking or blocking permission settings for suspicious domains, it prevents fake virus warnings, scam advertisements, and unwanted desktop popups from appearing on your screen.

> [!NOTE]
> **Compatibility:** This extension is designed specifically for Chromium-based browsers (such as Google Chrome, Microsoft Edge, Brave, Vivaldi, Opera, etc.) due to its reliance on the `chrome.contentSettings` API. It is not compatible with Firefox or Safari.

*Read this document in other languages:*
* 🇯🇵 [日本語版 (README.ja.md)](README.ja.md)

## The Problem: Notification Abuse
Many deceptive websites trick users into clicking "Allow Notifications" using fake Captcha prompts ("Click Allow to verify you are not a robot") or urgent security warnings ("Your system is infected!"). Once allowed, these sites abuse the browser's push notifications system to flood your screen with malicious alerts, adult advertisements, and virus scams—even when your browser is closed.

Because Chrome does not provide a direct API to retrieve a bulk list of all custom website notification permissions, auditing them is difficult. **NotiSpam Cleaner** solves this by harvesting active hostnames from your history, bookmarks, and open tabs, and querying their notification settings to find and clean unverified rules.

## Key Features

*   **🔒 100% Privacy-First & Open-Source:** All scans, audits, and blocks are processed strictly on your local machine. Absolutely zero data is collected, stored, or transmitted off your device. The extension is fully open-source (MIT License) for full auditing.
*   **🔍 Scan & One-Click Clean:** Instantly audits allowed website permissions against your local history, bookmarks, and open tabs. It automatically separates sites into "Trusted" and "Suspicious/Unknown", letting you revoke permissions from all suspicious websites at once.
*   **🛡️ Real-Time Guard & Silent Protection:** Actively monitors notification permission changes. When an unverified site gets allowed, the extension detects and blocks it. Includes a "Silent Protection" mode to auto-block notifications in the background—ideal for family members' PCs.

## Installation

### Method A: Install from Chrome Web Store (Recommended)
You can install the extension directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/notispam-cleaner-notifica/dahnhdiabhegihofjijbchegffnkiaap).


### Method B: Manual Developer Mode Installation
1.  Clone this repository:
    ```bash
    git clone https://github.com/mah-jp/notispam-cleaner.git
    ```
2.  Open Google Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** using the toggle in the top-right corner.
4.  Click **Load unpacked** in the top-left and select the `chrome_extension` folder from the cloned repository.

## Technical Architecture

*   **Manifest V3 Compliant:** Built using modern Chrome Extension API standards.
*   **Local Processing:** Integrates directly with the `chrome.contentSettings` API to read and write notification states.
*   **State Management:** Extensively utilizes `chrome.storage.local` for settings persistence and whitelisted domains, ensuring no memory leaks or global state issues during service worker lifecycles.

## How It Works (Real-Time Guard Flow)

The workflow for real-time notification monitoring ("Guard") and "Silent Protection" (Silent Guardian) is visualized in the following diagram:

```mermaid
graph TD
    %% Define styles/classes
    classDef page fill:#f5f5f5,stroke:#333,stroke-width:2px;
    classDef bg fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;
    classDef storage fill:#efebe9,stroke:#5d4037,stroke-width:2px;
    classDef api fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef user fill:#fff3e0,stroke:#ef6c00,stroke-width:2px;

    subgraph Web Page / Content Script
        A[Page Load / Permission Change] --> B{Is permission 'granted'?}
        B -- Yes --> C[Send Message:<br/>notification_granted]
    end

    subgraph Background Service Worker
        C --> D{Is Guard enabled?}
        D -- No --> E[End Process]
        D -- Yes --> F{Is domain whitelisted?}
        F -- Yes --> G["End Process (Keep Allowed)"]
        F -- No --> H[Immediately set notification setting to 'block']

        H --> I{Is Silent Guardian active?}
        
        %% Silent Guard Flow
        I -- Yes --> J[Increment blocked count]
        J --> K[Update badge text & color]
        K --> L[Silent Block Completed]
        
        %% Normal Guard Flow
        I -- No --> M[Show desktop alert notification]
    end

    subgraph Chrome Storage & API
        H -.-> |Update setting| API_Block[chrome.contentSettings]
        F -.-> |Read whitelist| Store_WL[chrome.storage.local]
        J -.-> |Update count| Store_Count[chrome.storage.local]
    end

    subgraph User Action (Desktop Notification)
        M --> N{User Choice}
        N -- "Dismiss" --> O["Clear notification (Keep Blocked)"]
        N -- "Trust & Allow" --> P[Add domain to whitelist]
        P --> Q[Change setting to 'allow']
        Q --> R[Clear notification & Update icon]
    end

    P -.-> |Save whitelist| Store_WL
    Q -.-> |Update setting| API_Allow[chrome.contentSettings]

    %% Apply classes
    class A,B,C page;
    class D,E,F,H,I,J,K,L,M bg;
    class Store_WL,Store_Count storage;
    class API_Block,API_Allow api;
    class N,O,P,Q,R user;
```


## Supported Languages (Locales)

This extension is fully localized and supports the following languages out of the box:
*   English (`en`) - Default
*   Japanese (`ja`)
*   Spanish (`es`)
*   Russian (`ru`)
*   Chinese (Simplified: `zh_CN` / Traditional: `zh_TW`)
*   Ukrainian (`uk`)
*   Korean (`ko`)
*   French (`fr`)
*   German (`de`)
*   Portuguese (`pt`)
*   Arabic (`ar`)
*   Hebrew (`he`)

## Author
*   **Masahiko OHKUBO** (GitHub: [@mah-jp](https://github.com/mah-jp))

## License
This project is open-source and licensed under the [MIT License](LICENSE).
