const commandstate = new Map();

function onBotPlay(game, playerNumber) {
    // INITS
    const allUnits = game.getUnits();
    const turnSubmission = { orders: [], autofireConfigChanges: [], formationChanges: [] };



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



    turnSubmission.formationChanges.push(...infantryFormationChanges(myinf, visibleEnemyUnits));
    const playerValues = initplayervalues(game, playerNumber);
    turnSubmission.orders.push(...infcommander(game, myinf, playerValues));



    return turnSubmission;
}

function infantryFormationChanges(infantry, visibleEnemyUnits) {
    const formationChanges = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());

    for (const unit of readyInfantry) {
        const multi=3;
        const enemyWithinRange = visibleEnemyUnits.some(enemy => {
            const distanceToEnemy = unit.position.distanceTo(enemy.position);
            return distanceToEnemy <= unit.getMaxRange() * multi;
        });
        const formationId = enemyWithinRange ? "line" : "column";

        if (unit.effectiveFormation === formationId) {
            continue;
        }

        formationChanges.push({ unitId: unit.id, formationId });
    }

    return formationChanges;
}

function initplayervalues(game, playerNumber) {
    const rotationtoenemy = playerNumber === 1 ? 3 * Math.PI / 2 : Math.PI / 2;
    const mapfarthesty = playerNumber === 1 ? 0 : game.map.height;

    return new Map([
        ["rotationtoenemy", rotationtoenemy],
        ["mapfarthesty", mapfarthesty]
    ]);
}

function infcommander(game, infantry, playerValues) {
    const orders = [];
    const readyInfantry = infantry.filter(unit => !unit.isRoutingOrRecovering());
    if (readyInfantry.length === 0) {
        return [];
    }

    const { lineWidth, lineFormation } = getlineinfo(readyInfantry);
    const { leftmostCenterObjective: lcentpos, rightmostCenterObjective: rcentpos } = getobjectiveinfo(game);
    const frontamt=getAmountThatFits(lcentpos, rcentpos, lineWidth);
    const rearamt=readyInfantry.length-frontamt;

    console.log(frontamt, rearamt,lineWidth,lineFormation, lcentpos, rcentpos,commandstate);
    

    if (commandstate.size === 0) {
        initializecommandstate(
            infantry,
            lcentpos,
            rcentpos,
            frontamt
        );
    }
    if (mostinfinposition(readyInfantry)) {
        commandstate.set("phase", "attack");
    }

    const oglineY=commandstate.get("oglineY");
    const stagingpositions=commandstate.get("stagingpositions");
    const phase = commandstate.get("phase");

    
    if (phase === "staging") {
        readyInfantry.slice(0, frontamt).forEach((unit, index) => {
            const position = stagingpositions[index];
            orders.push({
                type: 4,
                id: unit.id,
                path: [[position.x, position.y]],
                rotation: playerValues.get("rotationtoenemy")
            });
        });
    } else if (phase === "attack") {
        const positions = getEquallySpacedPositions(
            lcentpos,
            rcentpos,
            frontamt,
            playerValues.get("mapfarthesty")
        );

        readyInfantry.slice(0, frontamt).forEach((unit, index) => {
            const position = positions[index];
            orders.push({
                type: 4, // FAA
                id: unit.id,
                path: [[position.x, position.y]],
                rotation: playerValues.get("rotationtoenemy")
            });
        });
        
    }

    // ignore reserves for now
    // readyInfantry.slice(lineCount).forEach((unit, index) => {
    //     const linePosition = linePositions[index % linePositions.length];
    //     const reserveRow = Math.floor(index / linePositions.length) + 1;
    //     const reserveY = linePlacement.lineY + behindDirection * reserveDepth * reserveRow;
    //     orders.push({
    //         type: 4, // FAA
    //         id: unit.id,
    //         path: [[linePosition.x, reserveY]]
    //     });
    // });

    return orders;
}

function initializecommandstate(infantry, lcentpos, rcentpos, frontamt) {
    const oglineY = infantry.reduce((total, unit) => total + unit.position.y, 0) / infantry.length;
    const stagingY = (oglineY + lcentpos.y) / 2;
    const stagingpositions = getEquallySpacedPositions(
        lcentpos,
        rcentpos,
        frontamt,
        stagingY
    );

    commandstate.set("oglineY", oglineY);
    commandstate.set("stagingpositions", stagingpositions);
    commandstate.set("phase", "staging");
}

function mostinfinposition(infantry,threshold=10,percent=1) {
    const positions=commandstate.get("stagingpositions");
    const infantryToCheck = infantry.slice(0, positions.length);
    const inPositionCount = infantryToCheck.filter((unit, index) => {
        return unit.position.distanceTo(positions[index]) <= threshold;
    }).length;

    return inPositionCount / infantryToCheck.length >= percent;
}

function getlineinfo(readyInfantry) {
    const lineFormation = readyInfantry[0].gameDataManager.getUnitDimensions(
        readyInfantry[0].type,
        "line"
    );
    const lineWidth = lineFormation.height;
    return { lineWidth, lineFormation };
}

function getobjectiveinfo(game) {
    const objectives = game.getObjectives();
    if (objectives.length < 3) {
        console.log("NO OBJECTIVES???")
        return null;
    }

    // The three objectives closest to the map's horizontal center are the center line.
    const mapCenterY = game.map.height / 2;
    const centerObjectives = objectives
        .slice()
        .sort((a, b) => {
            const aCenterDistance = Math.abs(a.position.y - mapCenterY);
            const bCenterDistance = Math.abs(b.position.y - mapCenterY);
            return aCenterDistance - bCenterDistance;
        })
        .slice(0, 3)
        .sort((a, b) => a.position.x - b.position.x);

    return {
        leftmostCenterObjective: centerObjectives[0].position,
        rightmostCenterObjective: centerObjectives[2].position
    };
}

function getAmountThatFits(startPosition, endPosition, width) {
    const distanceX = endPosition.x - startPosition.x;
    const distanceY = endPosition.y - startPosition.y;
    const distance = Math.hypot(distanceX, distanceY);

    return Math.floor(distance / width);
}

function getEquallySpacedPositions(startPosition, endPosition, amount, y) {
    if (amount <= 0) {
        return [];
    }

    if (amount === 1) {
        return [{
            x: (startPosition.x + endPosition.x) / 2,
            y: y ?? (startPosition.y + endPosition.y) / 2
        }];
    }

    const positions = [];
    const intervals = amount - 1;
    const xStep = (endPosition.x - startPosition.x) / intervals;
    const yStep = (endPosition.y - startPosition.y) / intervals;

    for (let index = 0; index < amount; index += 1) {
        positions.push({
            x: startPosition.x + xStep * index,
            y: y ?? startPosition.y + yStep * index
        });
    }

    return positions;
}
