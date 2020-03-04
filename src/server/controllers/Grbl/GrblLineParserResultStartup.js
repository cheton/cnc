class GrblLineParserResultStartup {
    // Grbl 0.9j ['$' for help]
    // Grbl 1.1d ['$' for help]
    // Grbl 1.1h: LongMill build ['$' for help]
    // gCarvin 2.0.0 ['$' for help]
    static parse(line) {
        const r = line.match(/^([a-zA-Z0-9]+)\s+([^\[]*)\s+(\[[^\]]+\])/);
        if (!r) {
            return null;
        }

        const payload = {
            firmware: r[1],
            version: r[2],
            message: r[3]
        };

        return {
            type: GrblLineParserResultStartup,
            payload: payload
        };
    }
}

export default GrblLineParserResultStartup;
