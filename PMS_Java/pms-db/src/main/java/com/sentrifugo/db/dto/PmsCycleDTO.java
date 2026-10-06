package com.sentrifugo.db.dto;


import com.sentrifugo.db.enums.PmsCycleStatus;
import com.sentrifugo.db.enums.PmsCycleType;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleDTO extends BaseDTO {

    private UUID id;

    private String organisationId;

    private String cycleCode;

    private String name;

    private String description;

    private PmsCycleType type;

    private LocalDate periodStart;

    private LocalDate periodEnd;

    private PmsCycleStatus status;

    private UUID ratingScaleId;

    private Boolean notifyManagers;

    private Boolean notifyEmployees;

    private Boolean notifyHod;

    private Boolean notifyHr;

    private Integer currentStep;

    private Integer completedStep;

    private LocalDateTime publishedOn;
}