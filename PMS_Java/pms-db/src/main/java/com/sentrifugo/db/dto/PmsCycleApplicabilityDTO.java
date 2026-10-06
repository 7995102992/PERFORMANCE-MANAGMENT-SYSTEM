package com.sentrifugo.db.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleApplicabilityDTO extends BaseDTO {

    private UUID id;

    private Boolean allPlants;

    private Boolean allDepartments;

    private Integer minimumServiceMonths;

    private LocalDate serviceCalculatedAsOn;

    private Boolean excludeProbation;

    private Boolean excludeNoticePeriod;

    private UUID cycleId;
}
