package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsEligibilityRunStatus;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleEligibilityRunDTO extends BaseDTO {

    private UUID id;

    private PmsEligibilityRunStatus status;

    private LocalDateTime startedOn;

    private LocalDateTime completedOn;

    private Integer totalEligible;

    private Integer excludedProbation;

    private Integer excludedNoticePeriod;

    private Integer excludedMinService;

    private String errorMessage;

    private UUID cycleId;
}
