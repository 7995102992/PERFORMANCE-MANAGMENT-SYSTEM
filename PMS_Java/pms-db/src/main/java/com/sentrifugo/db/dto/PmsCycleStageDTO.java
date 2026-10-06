package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsCycleStageType;
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
public class PmsCycleStageDTO extends BaseDTO {

    private UUID id;

    private PmsCycleStageType stage;

    private LocalDate startDate;

    private LocalDate endDate;

    private Boolean notificationEnabled;

    private UUID cycleId;
}
