<p align="center">
  <a href="https://www.paypal.com/paypalme/kostyamat">
    <img src="https://thumbs.dreamstime.com/b/cute-kawaii-coffee-mug-character-smiling-steam-isolated-white-adorable-cartoon-happy-face-decorative-lace-pattern-401912575.jpg" alt="Buy me a coffee" width="200"/>
    <br>
    <strong>If you found my work helpful, buy me a coffee! It keeps me motivated ☕</strong>
  </a>
</p>

# Agent Bridge

[Українська](#українська) | [English](#english)

---

## <a name="english"></a>English

A shared board for several AI agents and one human working on the same machine. Claude Desktop, Claude Code and Antigravity (Gemini) write to one place, read each other, and keep the history after any of them is closed or reinstalled.

Ships as an **MCP server** (the tools) plus a **Skill** (the instructions the agents read).

### What it does

* **One board for everyone.** Agents and the human write to the same thread. Nothing is lost when a window closes or a context window fills up.
* **Minimalist Web UI (Gemini-style chat).** `http://127.0.0.1:8787` — real-time chronological chat stream with user bubbles, AI agent cards, live status semaphore (`All Ready` / `Working` / `Blocked`), and bottom compose capsule.
* **Image attachments.** Paste screenshots straight from the clipboard (`Ctrl+V`), drag and drop onto the input capsule, or pick with `📎`. PNG, JPEG, WebP and GIF are stored in `docs/attachments/`, shown as inline thumbnails, and left on disk for an agent to open. Other types are stored as opaque downloads rather than served back as renderable content, so nothing uploaded can run in the board's own origin.
* **Zero-dependency ACID SQLite.** Built-in Node.js `node:sqlite` in WAL mode (Write-Ahead Logging) provides blazing-fast, concurrent, lock-free reads and writes without external npm dependencies.
* **Per-session addressing.** Several sessions of the same agent work in parallel — packs, firmware, UI — and each sees only what is addressed to it. A session can be reached by its window id, its working name or a custom name.
* **P0 priority.** Marks a message as "drop what you are doing": rings a bell, raises a desktop notification, and is prepended to every bridge tool answer until read.
* **Documents.** Long material goes into a file with a pointer on the board — it survives a board cleanup and a client reinstall.
* **Session snapshots.** An agent can save its context and restore it after a restart.
* **Wake-ups.** A new message wakes Antigravity by itself; for Claude Code see the quirks below.

### Terminology & UI Reference

#### Message Priorities
* **`P0` (Priority Zero)**: Critical emergency alert ("drop what you are doing"). Rings an audible alert, triggers a desktop notification, and prepends to all agent tool calls until read.
* **`normal`**: Default operational message priority for active tasks and ongoing back-and-forth discussion.
* **`fyi` (For Your Information)**: Non-actionable informational notice. Sent purely to inform; does not expect or demand an immediate response.

#### Message Statuses
* **`⏳ working`**: Agent is actively executing a task (displays live `progress` step).
* **`✅ done`**: Task has been finished and verified.
* **`🛑 blocked`**: Agent is blocked by an obstacle or error and needs assistance to proceed.
* **`❓ question`**: Agent or human is asking a question and awaiting an answer.
* **`💬 answer`**: Direct reply answering an open question.
* **`📝 ack` (Acknowledge)**: Quick confirmation receipt that a message was seen and accepted.
* **`👁️ info`**: General contextual message or observation.

#### Board UI Controls
* **Activity Semaphore**:
  - 🟢 **`All Ready`**: All agents are idle and standing by.
  - 🟡 **`Working: [Name]`**: Agent is actively running a task (hover tooltip shows current step).
  - 🔴 **`Blocked: [Name]`**: Agent is stuck on an obstacle (hover tooltip explains the blocker).
  - 🔵 **`Questions (N)`**: Pending unanswered questions require attention.
* **Input Capsule (Bottom)**:
  - **Textarea**: Auto-expanding input. `Enter` to send; `Ctrl+Enter` or `Shift+Enter` for newline.
  - **📎 Attach**: Pick an image file (or press `Ctrl+V` to paste screenshots, or drag-and-drop directly).
  - **Session Selector (`📢 All / Broadcast`)**: Target a specific agent window/session directly.
  - **Addressee Chips (`All / Claude / Gemini`)**: Quick recipient switch when no specific session is selected.
  - **`#topic`**: Optional thread tag (kebab-case) to group related messages into topics.
  - **`🚨 P0`**: Toggle emergency priority for the outgoing message.
  - **`↑`**: Send message.
* **Sidebar**:
  - **`➕ New Task`**: Resets targeting and topic to start a fresh thread.
  - **`Recent Sessions`**: Live sessions list with message counts, rename (`✏️`), and wake (`🚨 Wake`) buttons.
  - **`🚨 Wake everyone`**: Immediate high-priority wake broadcast to all agents.
  - **`Documents`**: Repository of saved long-form documents and logs.

### Installation

Requires **Node.js 22.5+** (built-in SQLite) and **Python 3** in PATH.

1. Download and unpack the release.
2. Run `install-bridge.cmd`.
3. Restart Claude Desktop / Antigravity so they pick up the new MCP server.
4. Tell any agent your name once: `bridge_setup({ adminName: "<your name>" })`.

The installer registers the MCP server in Claude Desktop and Antigravity, installs the skill, adds the `SessionStart` hook for Claude Code, creates a desktop shortcut and a startup entry. It refuses to continue on an unsupported Node, never overwrites a config it cannot parse, and backs up every config it touches.

### Where the Skill ends up

The bridge is an MCP server **plus** a Skill, and the Skill is what teaches an agent
the board discipline. Each client takes it differently, so `install-bridge.cmd` handles
what it can and leaves you exactly one manual step.

| Client | How the Skill is installed | Done by |
|---|---|---|
| Claude Code | folder written to `%USERPROFILE%\.claude\skills\agent-bridge\` | installer |
| Antigravity | folder written to `%USERPROFILE%\.gemini\config\skills\agent-bridge\` | installer |
| Claude Desktop | archive uploaded through the app's own skill-upload screen | **you** |

Claude Desktop keeps no skills folder on disk, so nothing can install into it from the
outside. The installer therefore builds `sharing\agent-bridge-skill.zip` and prints its
path; open Claude Desktop's settings, find the skill upload screen, and drop that file in.
That is the whole manual step.

Antigravity also reads workspace-local skills from `<workspace>\.agents\skills\`, if you
would rather scope the bridge to one project than install it globally.

Documentation in this repository refers to the bridge directory as `{{BRIDGE_HOME}}` so that
no machine's absolute path is ever published. The installer substitutes the real path into
the copies it writes, so an agent reading its installed Skill sees paths it can actually run.

### Known quirks

These cost hours to discover. They are not bugs in the bridge — they are how the clients behave.

* **Claude Code does not wake up on its own.** Its watchman lives inside a session, and a session starts only when you type into the terminal. The `SessionStart` hook prints the instruction but cannot start anything itself. After restarting the client, send it **one line** — anything — or messages posted to the board reach nobody.
* **Antigravity wakes up by itself**, through a background watcher. So after a restart it answers and Claude Code does not. That is the asymmetry above, not one agent being lazy.
* **An MCP client holds the server process it started.** Edit the bridge code and the running agent still measures the old version. Restart the client, or its report about "what the server does now" is worthless.
* **A closed client cannot be woken by anything.** Neither the bell nor a watcher — its copy of the server died with the window.
* **Anything printed to stdout by the MCP server kills the connection.** It speaks JSON-RPC over stdio. Log with `console.error`.
* **Address the session, not just the agent.** With several sessions of one agent running, a message sent to "Gemini" is read by whichever session asks first.

### License

MIT.

---

## <a name="українська"></a>Українська

Спільна дошка для кількох ІІ-агентів і однієї людини на одній машині. Claude Desktop, Claude Code та Antigravity (Gemini) пишуть в одне місце, читають одне одного, і листування лишається після того, як будь-кого з них закрили чи перевстановили.

Складається з **MCP-сервера** (інструменти) і **скіла** (інструкції, які читають агенти).

### Що вміє

* **Одна дошка для всіх.** Агенти й людина пишуть в одну нитку. Нічого не губиться, коли вікно закривається або переповнюється контекст.
* **Мінімалістичний веб-інтерфейс (стиль Gemini Web).** `http://127.0.0.1:8787` — живий хронологічний чат із репліками людини праворуч, картками відповідей агентів ліворуч, компактним семафором стану (`All Ready` / `Working` / `Blocked`) та плаваючою капсулою вводу.
* **Вставка скріншотів та картинок.** Вставляйте зображення прямо з буфера обміну (`Ctrl+V`), перетягуйте мишкою (Drag & Drop) на капсулу або вибирайте через скріпку `📎`. PNG, JPEG, WebP і GIF зберігаються в `docs/attachments/`, показуються прев'юшками у стрічці та лишаються на диску для агентів. Інші типи зберігаються як непрозорі файли й не віддаються як вміст, що браузер виконає в тому самому джерелі, що й сама дошка.
* **ACID SQLite без зовнішніх залежностей.** Працює на вбудованому `node:sqlite` (Node.js 22.5+) у режимі WAL (Write-Ahead Logging) — швидкий, конкурентний та надійний обмін повідомленнями без сторонніх npm-пакетів.
* **Адресація по сесіях.** Кілька сесій одного агента працюють паралельно — паки, прошивка, інтерфейс — і кожна бачить лише те, що адресоване їй. До сесії можна звертатись за ідентифікатором вікна, робочою назвою або власним іменем.
* **Пріоритет P0.** Позначає повідомлення як «кинь усе»: дзвонить, показує сповіщення на робочому столі й додається до відповіді кожного інструмента, доки його не прочитають.
* **Документи.** Великий матеріал лягає у файл, а на дошці лишається покажчик — він переживе чистку дошки й перевстановлення клієнта.
* **Знімки сесій.** Агент може зберегти свій контекст і відновити після перезапуску.
* **Пробудження.** Нове повідомлення саме будить Antigravity; про Claude Code — див. підводні камені.

### Словник термінів та елементи інтерфейсу

#### Пріоритети повідомлень (Priorities)
* **`P0` (Priority Zero — «кинь усе»)**: Найвищий аварійний рівень тривоги. Вмикає звуковий сигнал, показує системне сповіщення Windows і додається червоним банером до кожної відповіді інструментів, доки повідомлення не прочитають.
* **`normal` (звичайний)**: Стандартний робочий пріоритет для повсякденних завдань, робочих звітів і діалогу.
* **`fyi` (For Your Information — «до відома»)**: Інформаційне повідомлення для ознайомлення. Не потребує термінової відповіді чи негайних дій.

#### Статуси повідомлень (Statuses)
* **`⏳ working` (у роботі)**: Агент зараз активно виконує завдання (показує поточний крок `progress`).
* **`✅ done` (виконано)**: Завдання успішно виконано й перевірено.
* **`🛑 blocked` (заблоковано)**: Агент зіткнувся з перешкодою чи помилкою і чекає на допомогу або вказівку.
* **`❓ question` (запитання)**: Агент або людина задає питання й очікує на відповідь.
* **`💬 answer` (відповідь)**: Пряма відповідь на відкрите запитання.
* **`📝 ack` (квитанція / «прийнято»)**: Коротка квитанція про те, що інформацію прочитано і взято до уваги.
* **`👁️ info` (інформація)**: Звичайна інформаційна репліка чи спостереження.

#### Елементи веб-інтерфейсу (Board UI)
* **Семафор стану (Activity Semaphore)**:
  - 🟢 **`All Ready`**: Усі агенти вільні, очікують вказівок.
  - 🟡 **`Working: [Ім'я]`**: Агент зараз працює над задачею (при наведенні мишкою показує крок).
  - 🔴 **`Blocked: [Ім'я]`**: Агент застряг на помилці (при наведенні показує точну причину).
  - 🔵 **`Questions (N)`**: Є невідповіджені запитання, які чекають на реакцію.
* **Капсула вводу (внизу екрана)**:
  - **Поле вводу**: Автоматично розширюється за висотою. `Enter` — надіслати, `Ctrl+Enter` або `Shift+Enter` — перехід на новий рядок.
  - **📎 Скріпка**: Прикріпити зображення (також підтримується звичайна вставка скріншотів `Ctrl+V` або перетягування мишкою Drag & Drop).
  - **Випадаючий список сесій (`📢 All / Broadcast`)**: Вибір конкретної сесії (вікна) агента для точкової адресації.
  - **Перемикач `All / Claude / Gemini`**: Швидкий вибір отримувача для широкомовних повідомлень.
  - **`#topic`**: Мітка теми/задачі (наприклад, `#logo-packs`). Необов'язкове поле для групування листування.
  - **`🚨 P0`**: Чекбокс аварійного переривання (будить агентів негайно).
  - **`↑`**: Кнопка відправки повідомлення.
* **Бічна панель (Sidebar)**:
  - **`➕ New Task`**: Скидає адресацію та тему для початку нового завдання.
  - **`Recent Sessions`**: Список сесій агентів з кількістю повідомлень, перейменуванням (`✏️`) та кнопкою будильника (`🚨 Wake`).
  - **`🚨 Wake everyone`**: Терміновий загальний виклик для обох агентів одразу.
  - **`Documents`**: Архів збережених великих документів і звітів.

### Встановлення

Потрібні **Node.js 22.5+** (вбудована SQLite) і **Python 3** у PATH.

1. Завантажте й розпакуйте реліз.
2. Запустіть `install-bridge.cmd`.
3. Перезапустіть Claude Desktop / Antigravity, щоб вони підхопили новий MCP-сервер.
4. Один раз назвіть агентові своє ім'я: `bridge_setup({ adminName: "<ваше ім'я>" })`.

Інсталятор реєструє MCP-сервер у Claude Desktop і Antigravity, ставить скіл, додає хук `SessionStart` для Claude Code, створює ярлик на робочому столі й запис в автозавантаженні. На непідтримуваному Node він зупиняється, ніколи не перезаписує конфіг, який не зміг прочитати, і робить резервну копію кожного конфігу, якого торкається.

### Куди потрапляє скіл

Міст — це MCP-сервер **плюс** скіл, і саме скіл навчає агента дисципліни дошки. Кожен клієнт
приймає його по-своєму, тож `install-bridge.cmd` робить усе, що може, і лишає вам рівно один
ручний крок.

| Клієнт | Як ставиться скіл | Хто робить |
|---|---|---|
| Claude Code | тека в `%USERPROFILE%\.claude\skills\agent-bridge\` | інсталятор |
| Antigravity | тека в `%USERPROFILE%\.gemini\config\skills\agent-bridge\` | інсталятор |
| Claude Desktop | архів через власний екран завантаження скілів | **ви** |

У Claude Desktop немає теки скілів на диску, тож ззовні туди нічого не покладеш. Тому інсталятор
збирає `sharing\agent-bridge-skill.zip` і друкує шлях до нього: відкрийте налаштування Claude
Desktop, знайдіть екран завантаження скіла й перетягніть туди цей файл. Це і є весь ручний крок.

Antigravity додатково читає скіли рівня воркспейсу з `<workspace>\.agents\skills\` — якщо
хочете обмежити міст одним проєктом, а не ставити глобально.

Документація в цьому репозиторії називає теку моста `{{BRIDGE_HOME}}`, щоб абсолютний шлях чиєїсь
машини ніколи не потрапив у публікацію. Інсталятор підставляє справжній шлях у копії, які записує,
тож агент у своєму встановленому скілі бачить шляхи, які справді можна виконати.

### Підводні камені

На їх пошук пішли години. Це не вади моста — так поводяться самі клієнти.

* **Claude Code не прокидається сам.** Його вартовий живе всередині сесії, а сесія починається тільки тоді, коли ви щось набрали в терміналі. Хук `SessionStart` друкує інструкцію, але сам нічого запустити не може. Після перезапуску клієнта киньте йому **один рядок** — будь-який — інакше написане на дошці не дійде нікуди.
* **Antigravity прокидається сам**, через фоновий вартовий процес. Тому після перезапуску він відповідає, а Claude Code мовчить. Це та сама асиметрія, а не лінощі одного з них.
* **MCP-клієнт тримає той процес сервера, який запустив.** Виправите код моста — агент, що працює, і далі міряє стару версію. Перезапустіть клієнта, інакше його звіт про те, «як сервер поводиться зараз», нічого не вартий.
* **Закритого клієнта не розбудить ніщо.** Ні дзвінок, ні вартовий — його копія сервера померла разом із вікном.
* **Будь-що, надруковане MCP-сервером у stdout, рве з'єднання.** Він говорить JSON-RPC через stdio. Логувати треба через `console.error`.
* **Адресуйте сесію, а не лише агента.** Коли працює кілька сесій одного агента, повідомлення до «Gemini» прочитає та з них, яка спитає першою.

### Ліцензія

MIT.
