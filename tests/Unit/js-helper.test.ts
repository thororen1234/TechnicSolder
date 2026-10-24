import { js } from '../../src/views/helpers.js'

describe('js()', () => {
    it('encodes like Laravel Js::from', () => {
        expect(js('http://a/b')).toBe("'http:\\/\\/a\\/b'")
        expect(js(`it's "x" <b>&`)).toBe("'it\\u0027s \\u0022x\\u0022 \\u003Cb\\u003E\\u0026'")
        expect(js('é')).toBe("'\\u00e9'")
        expect(js(5)).toBe('5')
        expect(js(null)).toBe('null')
        expect(js(true)).toBe('true')
        expect(js([])).toBe('[]')
        expect(js({})).toBe('{}')
        expect(js({ a: 'b"c' })).toBe("JSON.parse('{\\u0022a\\u0022:\\u0022b\\\\u0022c\\u0022}')")
    })

    it('evaluates back to the value', () => {
        const value = { name: `Tom's "pack" </script> \\ end`, list: [1, 'two', null], nested: { url: 'http://x/y' } }
        expect(new Function(`return ${js(value)}`)()).toEqual(value)
        expect(new Function(`return ${js(value.name)}`)()).toBe(value.name)
    })
})
