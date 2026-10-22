import Alpine from 'alpinejs'
import collapse from '@alpinejs/collapse'

Alpine.plugin(collapse)

window.Alpine = Alpine

// Dark mode store
Alpine.store('darkMode', {
    on: document.documentElement.classList.contains('dark'),
    toggle() {
        this.on = !this.on
        localStorage.setItem('darkMode', this.on)
        document.documentElement.classList.toggle('dark', this.on)
        document.documentElement.style.colorScheme = this.on ? 'dark' : 'light'
    }
})

// Toast notification store
Alpine.store('toasts', {
    items: [],
    add(message, type = 'success') {
        const id = Date.now()
        this.items.push({ id, message, type })
        setTimeout(() => this.remove(id), 4000)
    },
    remove(id) {
        this.items = this.items.filter(i => i.id !== id)
    }
})

// CSRF-aware fetch wrapper
window.csrfToken = document.querySelector('meta[name="csrf-token"]')?.content

window.ajax = async (url, options = {}) => {
    const res = await fetch(url, {
        headers: {
            'X-CSRF-TOKEN': window.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...options.headers,
        },
        ...options,
    })
    return res.json()
}

window.ajaxPost = (url, data = {}) => {
    return window.ajax(url, {
        method: 'POST',
        body: JSON.stringify(data),
    })
}

// Simple slugify
window.slugify = (text) => {
    return text.toString().toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

// Data-driven DataTable component: sort, filter, paginate.
// Rows are passed as a JSON array. Computed getters (filtered → sorted → paged)
// drive an x-for template — no DOM manipulation needed.
Alpine.data('dataTable', (config = {}) => ({
    rows: config.rows || [],
    sortKey: config.sortKey || null,
    sortDir: config.sortDir || 'asc',
    search: '',
    page: 1,
    pageSize: config.pageSize || 25,
    paginate: config.paginate !== false,
    types: config.types || {},
    searchKeys: config.searchKeys || null,
    tableName: config.tableName || null,
    storageKey: 'dataTable:' + (config.tableName || window.location.pathname),

    init() {
        this.$watch('search', () => { this.page = 1; });

        // Allow deep links such as /mod/list?q=forge (used by the command palette)
        const query = new URLSearchParams(window.location.search).get('q');
        if (query) this.search = query;

        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
            try {
                const { sortKey, sortDir } = JSON.parse(stored);
                if (sortKey && this.rows.length > 0 && sortKey in this.rows[0]) {
                    this.sortKey = sortKey;
                    this.sortDir = sortDir || 'asc';
                }
            } catch (e) {}
        }
    },

    sort(key) {
        if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortKey = key;
            this.sortDir = 'asc';
        }
        this.page = 1;
        localStorage.setItem(this.storageKey, JSON.stringify({ sortKey: this.sortKey, sortDir: this.sortDir }));
    },

    get filtered() {
        if (!this.search) return this.rows;
        const s = this.search.toLowerCase();
        const keys = this.searchKeys || Object.keys(this.rows[0] || {});
        return this.rows.filter(row =>
            keys.some(k => String(row[k] ?? '').toLowerCase().includes(s))
        );
    },

    get sorted() {
        const key = this.sortKey;
        if (!key) return this.filtered;
        const dir = this.sortDir === 'asc' ? 1 : -1;
        const type = this.types[key] || 'string';
        return [...this.filtered].sort((a, b) => {
            let va = a[key] ?? '', vb = b[key] ?? '';
            if (type === 'number') return ((parseFloat(va) || 0) - (parseFloat(vb) || 0)) * dir;
            if (type === 'date') return ((new Date(va).getTime() || 0) - (new Date(vb).getTime() || 0)) * dir;
            return dir * String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        });
    },

    get paged() {
        if (!this.paginate) return this.sorted;
        const start = (this.page - 1) * this.pageSize;
        return this.sorted.slice(start, start + this.pageSize);
    },

    get totalFiltered() { return this.filtered.length; },
    get totalRows() { return this.rows.length; },
    get totalPages() { return this.paginate ? Math.max(1, Math.ceil(this.totalFiltered / this.pageSize)) : 1; },
    get showingFrom() { return this.totalFiltered === 0 ? 0 : (this.page - 1) * this.pageSize + 1; },
    get showingTo() { return Math.min(this.page * this.pageSize, this.totalFiltered); },
    get pageNumbers() {
        const total = this.totalPages;
        const current = this.page;
        const pages = [];
        if (total <= 7) {
            for (let i = 1; i <= total; i++) pages.push(i);
        } else {
            pages.push(1);
            if (current > 3) pages.push('...');
            for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
                pages.push(i);
            }
            if (current < total - 2) pages.push('...');
            pages.push(total);
        }
        return pages;
    },

    goToPage(n) { this.page = n; },
    prevPage() { if (this.page > 1) this.page--; },
    nextPage() { if (this.page < this.totalPages) this.page++; },
}));

// Pages offered by the command palette, grouped by nav section.
const NAV_SECTIONS = [
    { label: 'Overview', url: '/dashboard', links: [] },
    {
        label: 'Modpacks',
        links: [
            { label: 'All modpacks', url: '/modpack/list' },
            { label: 'New modpack', url: '/modpack/create' },
            { label: 'Import modpack', url: '/modpack/import' },
        ],
    },
    {
        label: 'Mods',
        links: [
            { label: 'All mods', url: '/mod/list' },
            { label: 'New mod', url: '/mod/create' },
            { label: 'Import mod', url: '/mod/import' },
        ],
    },
    {
        label: 'Settings',
        links: [
            { label: 'Configuration', url: '/solder/configure' },
            { label: 'Updates', url: '/solder/update' },
            { label: 'Mod repository', url: '/solder/repository' },
            { label: 'Activity', url: '/solder/activity' },
            { label: 'Users', url: '/user/list' },
            { label: 'Clients', url: '/client/list' },
            { label: 'Platform keys', url: '/key/list' },
        ],
    },
]

const pathMatches = (path, prefixes) => prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'))

Alpine.data('shell', (config = {}) => ({
    path: window.location.pathname,
    // Resolved before first paint by the inline script in the layout <head>
    section: document.documentElement.dataset.section || null,
    modpacks: config.modpacks || [],
    currentModpackId: config.currentModpackId ?? null,
    isMac: /Mac|iPhone|iPad/.test(navigator.userAgent),
    tip: { show: false, text: '', top: 0 },

    init() {
        if (this.currentModpackId === null) {
            const match = this.path.match(/^\/modpack\/(?:view|edit|delete|clone|add-build)\/(\d+)/)
            if (match) this.currentModpackId = Number(match[1])
        }
    },

    isCurrent(prefixes) {
        return pathMatches(this.path, prefixes)
    },

    showTip(el, text) {
        const rect = el.getBoundingClientRect()
        this.tip = { show: true, text, top: rect.top + rect.height / 2 }
    },
}))

// ⌘K command palette: jump to pages and modpacks, or search mods/modpacks.
Alpine.data('commandPalette', (config = {}) => ({
    open: false,
    query: '',
    active: 0,
    modpacks: config.modpacks || [],
    profileUrl: config.profileUrl || null,

    init() {
        window.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                this.toggle()
            }
        })
        this.$watch('query', () => { this.active = 0 })
    },

    toggle() {
        this.open ? this.close() : this.show()
    },

    show() {
        this.open = true
        this.query = ''
        this.active = 0
        this.$nextTick(() => this.$refs.input?.focus())
    },

    close() {
        this.open = false
    },

    get pages() {
        const pages = []
        NAV_SECTIONS.forEach(section => {
            if (!section.links.length) {
                pages.push({ label: section.label, hint: 'Page', url: section.url })
            }
            section.links.forEach(link => pages.push({ label: link.label, hint: section.label, url: link.url }))
        })
        if (this.profileUrl) pages.push({ label: 'Your profile', hint: 'Account', url: this.profileUrl })
        return pages
    },

    get groups() {
        const q = this.query.trim().toLowerCase()
        const rank = (text) => {
            const t = text.toLowerCase()
            if (!q) return 1
            if (t.startsWith(q)) return 0
            if (t.includes(q)) return 1
            return -1
        }
        const score = (keys) => {
            const ranks = keys.filter(Boolean).map(rank).filter(r => r >= 0)
            return ranks.length ? Math.min(...ranks) : -1
        }
        const filter = (items, keyFn, limit) => items
            .map(item => ({ item, score: score(keyFn(item)) }))
            .filter(r => r.score >= 0)
            .sort((a, b) => a.score - b.score)
            .slice(0, limit)
            .map(r => r.item)

        const groups = []

        const modpacks = filter(this.modpacks, mp => [mp.name, mp.slug], q ? 8 : 5)
            .map(mp => ({ type: 'modpack', label: mp.name, hint: mp.slug, url: '/modpack/view/' + mp.id, icon: mp.icon_url }))
        if (modpacks.length) groups.push({ label: 'Modpacks', items: modpacks })

        const pages = filter(this.pages, p => [p.label, p.hint], q ? 8 : 20)
            .map(p => ({ type: 'page', ...p }))
        if (pages.length) groups.push({ label: 'Go to', items: pages })

        if (q) {
            groups.push({
                label: 'Search',
                items: [
                    { type: 'search', label: `Search mods for “${this.query.trim()}”`, url: '/mod/list?q=' + encodeURIComponent(this.query.trim()) },
                    { type: 'search', label: `Search modpacks for “${this.query.trim()}”`, url: '/modpack/list?q=' + encodeURIComponent(this.query.trim()) },
                ],
            })
        }

        groups.push({
            label: 'Actions',
            items: filter([{ type: 'action', label: 'Toggle dark mode', hint: 'Theme', run: () => Alpine.store('darkMode').toggle() }], a => [a.label, a.hint], 1),
        })

        // Flat index for keyboard navigation
        let index = 0
        groups.forEach(g => g.items.forEach(item => { item.index = index++ }))
        return groups.filter(g => g.items.length)
    },

    get flat() {
        return this.groups.flatMap(g => g.items)
    },

    move(delta) {
        const count = this.flat.length
        if (!count) return
        this.active = (this.active + delta + count) % count
        this.$nextTick(() => this.$refs.list?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
    },

    choose(item = this.flat[this.active]) {
        if (!item) return
        this.close()
        if (item.run) {
            item.run()
        } else {
            window.location.href = item.url
        }
    },
}))

Alpine.start()
