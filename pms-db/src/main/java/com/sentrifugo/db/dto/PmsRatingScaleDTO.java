package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsMasterStatus;
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
public class PmsRatingScaleDTO extends BaseDTO {

    private UUID id;

    private UUID organisationId;

    private String name;

    private String description;

    private PmsMasterStatus status;

    private Boolean isDefault;

    private Boolean showDefinitionsToEmployees;
}
