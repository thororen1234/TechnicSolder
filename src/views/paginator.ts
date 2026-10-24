import { Collection } from './collection.js'

/**
 * One page of results with Laravel's paginator methods ($entries->hasPages(), ->links()).
 */
export class Paginator<T> extends Collection<T> {
    currentPageNumber = 1
    lastPageNumber = 1
    totalCount = 0
    perPageCount = 50
    /** The page URL with "{page}" for the page number */
    urlPattern = '?page={page}'

    static paginate<T>(items: T[], total: number, page: number, perPage: number, urlPattern: string): Paginator<T> {
        const paginator = new Paginator<T>()
        paginator.push(...items)
        paginator.totalCount = total
        paginator.perPageCount = perPage
        paginator.currentPageNumber = page
        paginator.lastPageNumber = Math.max(1, Math.ceil(total / perPage))
        paginator.urlPattern = urlPattern
        return paginator
    }

    currentPage(): number {
        return this.currentPageNumber
    }

    lastPage(): number {
        return this.lastPageNumber
    }

    total(): number {
        return this.totalCount
    }

    hasPages(): boolean {
        return this.lastPageNumber > 1
    }

    url(page: number): string {
        return this.urlPattern.replace('{page}', String(page))
    }

    /** Previous/next links and the page numbers, styled like the rest of the interface */
    links(): string {
        if (!this.hasPages()) {
            return ''
        }
        const link = (page: number, label: string, disabled = false, current = false) =>
            disabled || current
                ? `<span class="ui-page-btn${current ? ' ui-page-btn-active' : ' opacity-50'}"${current ? ' aria-current="page"' : ''}>${label}</span>`
                : `<a href="${this.url(page)}" class="ui-page-btn">${label}</a>`
        const pages: string[] = []
        for (let page = 1; page <= this.lastPageNumber; page++) {
            if (page === 1 || page === this.lastPageNumber || Math.abs(page - this.currentPageNumber) <= 2) {
                pages.push(link(page, String(page), false, page === this.currentPageNumber))
            } else if (pages[pages.length - 1] !== '<span class="ui-page-btn">…</span>') {
                pages.push('<span class="ui-page-btn">…</span>')
            }
        }
        return [
            '<nav role="navigation" aria-label="Pagination" class="flex items-center justify-between gap-3 text-sm text-gray-600 dark:text-gray-400">',
            `<span>Page ${this.currentPageNumber} of ${this.lastPageNumber}</span>`,
            '<div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/5">',
            link(this.currentPageNumber - 1, '&lsaquo;', this.currentPageNumber <= 1),
            ...pages,
            link(this.currentPageNumber + 1, '&rsaquo;', this.currentPageNumber >= this.lastPageNumber),
            '</div>',
            '</nav>',
        ].join('')
    }
}
