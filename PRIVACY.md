# Privacy Policy — NotiSpam Cleaner

Last Updated: 2026-05-28

NotiSpam Cleaner (referred to as "this extension") is designed with a privacy-first approach. This Privacy Policy describes how we handle user data.

## 1. Data Collection and Transmission
This extension **does not collect, store, or transmit any personal data, browsing history, or sensitive user information** off your device. All operations are processed strictly on the client side (locally on your machine).

## 2. Required Permissions and Purposes
This extension requests only the minimum permissions necessary to function as a notification spam detector and blocker:

- **`contentSettings`**
  - Used to read and modify site-specific notification permission levels (e.g., blocking or allowing sites).
- **`history`**
  - Used to scan recently visited hostnames to audit whether they have active notification permissions.
- **`bookmarks`**
  - Used to scan bookmarked hostnames to audit whether they have active notification permissions.
- **`tabs`**
  - Used to audit active open tab hostnames for current notification permissions.
- **`notifications`**
  - Used to display system-level alerts when the Real-time Protection Guard automatically blocks a suspicious notification permission.
- **`storage`**
  - Used to save the settings (e.g. guard status) and your custom whitelist of trusted domains locally inside Chrome.

## 3. Third-Party Services
We do not integrate any third-party ads, analytics trackers, or telemetry tools. No data is ever shared with, sold to, or accessible by third parties.

## 4. Security
Since all data processing runs locally within your browser context, there is no risk of remote server leaks. The extension source code is clean, transparent, and contains no obfuscated segments.

## 5. Changes to This Policy
We may update this Privacy Policy from time to time to reflect changes in our functionality. The updated date at the top of this document will be revised accordingly.

## 6. Contact & Support
If you have any questions or feedback regarding privacy, feel free to contact us:
- Support Center (GitHub Issues): https://github.com/mah-jp/notispam-cleaner/issues
