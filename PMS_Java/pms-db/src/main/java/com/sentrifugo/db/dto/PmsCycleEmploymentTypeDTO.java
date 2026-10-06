package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsEmploymentType;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsCycleEmploymentTypeDTO extends BaseDTO {

    private UUID id;

    private PmsEmploymentType employmentType;

    private UUID cycleId;
}
