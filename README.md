<div align="center">
  
# 🧠 Wellagent Core

**The intelligence engine powering your local AI agents.**

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#)

</div>

<br />

**Wellagent Core** is the "brain" behind the Wellagent ecosystem. It manages everything your AI agents need to think, remember, and act on your behalf—all while keeping your data strictly private and under your control.

---

## ✨ Features

- 🤖 **Universal AI Support**: Connects seamlessly to OpenAI, Anthropic, open-source local models (via Ollama or LM Studio), and OpenRouter. You choose who powers your agent.
- 🧠 **Persistent Memory**: Gives your agents the ability to remember past conversations, facts, and your personal preferences across entirely different sessions.
- 🛠️ **Real-World Actions**: Equips your agents with powerful tools to search the web, read files, run terminal commands, and perform complex multi-step workflows.
- 🛡️ **Absolute Privacy**: Designed from the ground up to keep your data safe. The core engine runs entirely locally and only communicates with the external services you explicitly authorize.
- 🔌 **Unified Intelligence**: Powers the entire ecosystem with a single, reliable brain. 

---

## 🚀 Where do I start?

If you are a user looking to use Wellagent, **you do not need to install the core directly!** 

Instead, install one of the apps powered by this engine:

- 💻 **[Wellagent Desktop](https://github.com/dkeiz/wellagent-desktop)** — The beautiful, feature-rich graphical app for Windows, Mac, and Linux.
- 📱 **[Wellagent Companion](https://github.com/dkeiz/wellagent-companion)** — Connect with your agents on the go.
- 🤖 **[Wellbot](https://github.com/dkeiz/wellbot)** — A powerful command-line interface for interacting with your agents directly from your terminal.

---

### 👨‍💻 For Developers

Are you a developer looking to build custom agent applications or plugins using the headless `wellagent-core` engine? 

Please refer to the technical [API & Architecture Documentation](src/README.md) for details on storage ports, tool provisioning, and custom inference dispatchers.
