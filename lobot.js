function infcommander(game, infantry) {
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    if (readyInfantry.length === 0) {
        return [];
    }

    const objectives = game.getObjectives();
    if (objectives.length < 3) {
        return [];
    }

    // The three objectives closest to the map's horizontal center are the center line.
    const mapCenterY = game.map.height / 2;
    const centerObjectives = objectives.slice().sort((a, b) => Math.abs(a.position.y - mapCenterY) - Math.abs(b.position.y - mapCenterY)).slice(0, 3).sort((a, b) => a.position.x - b.position.x);
    const lineFormation = readyInfantry[0].gameDataManager.getUnitDimensions(readyInfantry[0].type, "line");
    const lineWidth = lineFormation.width;
    const lineLength = centerObjectives[2].position.x - centerObjectives[0].position.x + lineWidth;
    const lineStartX = centerObjectives[0].position.x - lineWidth / 2;
    const lineY = centerObjectives.reduce((sum, objective) => sum + objective.position.y, 0) / centerObjectives.length;
    const lineCount = Math.min(readyInfantry.length, Math.max(1, Math.floor(lineLength / lineWidth) + 1));
    const lineSpacing = lineCount > 1 ? lineLength / (lineCount - 1) : 0;
    const linePositions = Array.from({ length: lineCount }, (_, index) => ({ x: lineStartX + index * lineSpacing, y: lineY }));
    const averageInfantryY = readyInfantry.reduce((sum, unit) => sum + unit.position.y, 0) / readyInfantry.length;
    const behindDirection = averageInfantryY <= lineY ? -1 : 1;
    const reserveDepth = Math.max(lineFormation.height + lineWidth / 2, lineWidth);
    const orders = [];

    readyInfantry.slice(0, lineCount).forEach((unit, index) => {
        const position = linePositions[index];
        orders.push({
            type: 1, // Walk
            id: unit.id,
            path: [[position.x, position.y]]
        });
    });

    readyInfantry.slice(lineCount).forEach((unit, index) => {
        const linePosition = linePositions[index % linePositions.length];
        const reserveRow = Math.floor(index / linePositions.length) + 1;
        const reserveY = lineY + behindDirection * reserveDepth * reserveRow;
        orders.push({
            type: 1, // Walk
            id: unit.id,
            path: [[linePosition.x, reserveY]]
        });
    });

    return orders;
}

function onBotPlay(game, playerNumber) {
    // INITS
    const allUnits = game.getUnits();
    const turnSubmission = { orders: [], autofireConfigChanges: [] };

    // LOGS
    // console.log("Unit categories:", allUnits.map(unit => ({
    //   id: unit.id,
    //   player: unit.player,
    //   category: unit.category
    // })));
    console.log(game)
    const visibleEnemyUnits = game.getVisibleEnemyUnits(playerNumber);
    console.log("Visible enemy units:", visibleEnemyUnits.map(unit => ({ id: unit.id, category: unit.category, x: unit.position.x, y: unit.position.y })));

    // UNITS
    const myUnits = allUnits.filter(unit => unit.player === playerNumber);
    const enemyUnits = allUnits.filter(unit => unit.team !== game.getPlayerTeam(playerNumber));
    // Group units by their battlefield category.
    const mycav = myUnits.filter(unit => ["scoutCavalry", "lightCavalry", "midCavalry", "heavyCavalry"].includes(unit.category));
    const myarty = myUnits.filter(unit => unit.category === "artillery");
    const myinf = myUnits.filter(unit => ["infantry", "guardsInfantry", "militiaInfantry"].includes(unit.category));
    const myskirms = myUnits.filter(unit => unit.category === "skirmishInfantry");

    turnSubmission.orders.push(...infcommander(game, myinf));

    return turnSubmission;
}
